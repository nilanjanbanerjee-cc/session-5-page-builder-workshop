import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { readdir, rm } from "node:fs/promises";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureApplication } from "../../src/main";
import { AppConfigService } from "../../src/common/config/app-config.service";
import { PrismaService } from "../../src/database/prisma.service";

type ProjectResponse = {
  id: string;
  name: string;
  slug: string;
  blocks: unknown[];
  publishedAt: string | null;
  lastSuccessfulPublishAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectListResponse = {
  items: ProjectResponse[];
  page: number;
  pageSize: number;
  total: number;
};

const baselineBlocks = [
  { id: "heading-1", type: "heading", text: "Welcome", level: 1 },
  { id: "text-1", type: "text", text: "Original body" },
  { id: "button-1", type: "button", label: "Open", url: "https://example.com" },
  { id: "section-1", type: "section", title: "Details" }
];

describe("project API", () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let config: AppConfigService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
    config = app.get(AppConfigService);
  });

  beforeEach(async () => {
    await prisma.project.deleteMany();
    await rm(config.publishDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createProject(overrides: Record<string, unknown> = {}): Promise<ProjectResponse> {
    const response = await request(app.getHttpServer())
      .post("/api/projects")
      .send({ name: "Workshop page", slug: "workshop-page", blocks: baselineBlocks, ...overrides })
      .expect(201);
    return response.body as ProjectResponse;
  }

  it("exposes liveness, Swagger, and the builder redirect", async () => {
    await request(app.getHttpServer()).get("/health").expect(200, { status: "ok" });
    await request(app.getHttpServer()).get("/api/docs").expect(200).expect("content-type", /html/);
    await request(app.getHttpServer())
      .get("/api/openapi.json")
      .expect(200)
      .expect("content-type", /json/)
      .expect(({ body }: { body: { openapi?: string } }) => {
        expect(body.openapi).toBe("3.0.0");
      });
    await request(app.getHttpServer()).get("/").expect(302).expect("location", "/builder/");
  });

  it("creates and loads a project with typed ordered blocks", async () => {
    const created = await createProject();

    expect(created).toMatchObject({
      name: "Workshop page",
      slug: "workshop-page",
      blocks: baselineBlocks,
      publishedAt: null
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(created.createdAt)).not.toBeNaN();

    await request(app.getHttpServer())
      .get(`/api/projects/${created.id}`)
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body).toEqual(created);
      });
  });

  it("persists a divider block and publishes it as a horizontal rule", async () => {
    const created = await createProject({ blocks: [
      { id: "heading-1", type: "heading", text: "Welcome", level: 1 },
      { id: "divider-1", type: "divider" },
      { id: "text-1", type: "text", text: "After the divider" }
    ] });

    expect(created.blocks).toEqual([
      { id: "heading-1", type: "heading", text: "Welcome", level: 1 },
      { id: "divider-1", type: "divider" },
      { id: "text-1", type: "text", text: "After the divider" }
    ]);

    await request(app.getHttpServer()).post(`/api/projects/${created.id}/publish`).expect(201);
    await request(app.getHttpServer())
      .get("/sites/workshop-page")
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain("<hr>");
      });
  });

  it("replaces editable project fields and ordered blocks", async () => {
    const created = await createProject();
    const replacement = {
      name: "Updated page",
      slug: "updated-page",
      blocks: [...baselineBlocks].reverse()
    };

    await request(app.getHttpServer())
      .put(`/api/projects/${created.id}`)
      .send(replacement)
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body).toMatchObject(replacement);
        expect(body.id).toBe(created.id);
      });
  });

  it("duplicates a project with ordered blocks, a new identity, and an unpublished copy", async () => {
    const source = await createProject({ slug: "source-page" });
    await request(app.getHttpServer()).post(`/api/projects/${source.id}/publish`).expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/projects/${source.id}/duplicate`)
      .expect(201);
    const copy = response.body as ProjectResponse;

    expect(copy).toMatchObject({
      name: source.name,
      slug: "source-page-copy",
      blocks: source.blocks,
      publishedAt: null,
      lastSuccessfulPublishAt: null
    });
    expect(copy.id).not.toBe(source.id);

    await request(app.getHttpServer())
      .get(`/api/projects/${copy.id}`)
      .expect(200, copy);
  });

  it("uses a nonconflicting slug when duplicating a project", async () => {
    const source = await createProject();
    await createProject({ name: "Existing copy", slug: "workshop-page-copy" });

    await request(app.getHttpServer())
      .post(`/api/projects/${source.id}/duplicate`)
      .expect(201)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body.slug).toBe("workshop-page-copy-2");
      });
  });

  it("returns the existing not-found envelope when duplicating an unknown project", async () => {
    await request(app.getHttpServer())
      .post("/api/projects/123e4567-e89b-42d3-a456-426614174000/duplicate")
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });
  });

  it.each([
    ["empty name", { name: "" }],
    ["whitespace-only name", { name: "   " }],
    ["uppercase slug", { slug: "Not-Lowercase" }],
    ["unknown block", { blocks: [{ id: "x", type: "spacer" }] }],
    ["duplicate block ID", { blocks: [
      { id: "same", type: "text", text: "First" },
      { id: "same", type: "section", title: "Second" }
    ] }]
  ])("returns the common 400 envelope for an invalid %s", async (_description, override) => {
    await request(app.getHttpServer())
      .post("/api/projects")
      .send({ name: "Workshop page", slug: "workshop-page", blocks: baselineBlocks, ...override })
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        expect(typeof body.message).toBe("string");
      });
  });

  it("returns a common conflict envelope for an occupied slug", async () => {
    await createProject();

    await request(app.getHttpServer())
      .post("/api/projects")
      .send({ name: "Second", slug: "workshop-page", blocks: [] })
      .expect(409, {
        statusCode: 409,
        code: "SLUG_CONFLICT",
        message: "That slug is already in use",
        details: { slug: "workshop-page" }
      });
  });

  it("trims project names before persistence", async () => {
    const project = await createProject({ name: "  Workshop page  " });

    expect(project.name).toBe("Workshop page");
  });

  it("reports draft then published status without exposing block content", async () => {
    const created = await createProject();

    await request(app.getHttpServer())
      .get(`/api/projects/${created.id}/status`)
      .expect(200, { id: created.id, status: "draft", publishedAt: null });

    const publishResponse = await request(app.getHttpServer())
      .post(`/api/projects/${created.id}/publish`)
      .expect(201);
    const published = (publishResponse.body as { project: ProjectResponse }).project;

    await request(app.getHttpServer())
      .get(`/api/projects/${created.id}/status`)
      .expect(200, { id: created.id, status: "published", publishedAt: published.publishedAt });
  });

  it("reports draft status again after a published project is edited", async () => {
    const created = await createProject();
    await request(app.getHttpServer()).post(`/api/projects/${created.id}/publish`).expect(201);

    await request(app.getHttpServer())
      .put(`/api/projects/${created.id}`)
      .send({ name: created.name, slug: created.slug, blocks: created.blocks })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/projects/${created.id}/status`)
      .expect(200, { id: created.id, status: "draft", publishedAt: null });
  });

  it("returns common not-found and malformed-ID envelopes for status", async () => {
    await request(app.getHttpServer())
      .get("/api/projects/123e4567-e89b-42d3-a456-426614174000/status")
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });

    await request(app.getHttpServer())
      .get("/api/projects/not-a-uuid/status")
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
      });
  });

  it("returns common not-found and malformed-ID envelopes", async () => {
    await request(app.getHttpServer())
      .get("/api/projects/123e4567-e89b-42d3-a456-426614174000")
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });

    await request(app.getHttpServer())
      .get("/api/projects/not-a-uuid")
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
      });
  });

  it("requires explicit confirmation to delete a project", async () => {
    const project = await createProject();

    await request(app.getHttpServer())
      .delete(`/api/projects/${project.id}`)
      .send({})
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
      });

    await request(app.getHttpServer())
      .delete(`/api/projects/${project.id}`)
      .send({ confirm: false })
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
      });

    await request(app.getHttpServer())
      .get(`/api/projects/${project.id}`)
      .expect(200);
  });

  it("deletes a project only when confirmation is true", async () => {
    const project = await createProject();
    const other = await createProject({ name: "Other page", slug: "other-page" });

    await request(app.getHttpServer())
      .delete(`/api/projects/${project.id}`)
      .send({ confirm: true })
      .expect(204);

    await request(app.getHttpServer())
      .get(`/api/projects/${project.id}`)
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });

    await request(app.getHttpServer())
      .get(`/api/projects/${other.id}`)
      .expect(200);
  });

  it("returns 404 when deleting an unknown project", async () => {
    await request(app.getHttpServer())
      .delete("/api/projects/123e4567-e89b-42d3-a456-426614174000")
      .send({ confirm: true })
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });
  });

  it("keeps the 20 block limit in the builder instead of the API", async () => {
    const blocks = Array.from({ length: 21 }, (_, index) => ({
      id: `text-${index}`,
      type: "text",
      text: `Block ${index}`
    }));

    await createProject({ blocks });
  });

  it("publishes and republishes an isolated static document", async () => {
    const first = await createProject();
    const second = await createProject({ name: "Other page", slug: "other-page", blocks: [
      { id: "other", type: "text", text: "Other project content" }
    ] });

    await request(app.getHttpServer())
      .post(`/api/projects/${first.id}/publish`)
      .expect(201)
      .expect(({ body }: { body: { project: ProjectResponse; url: string } }) => {
        expect(body.url).toBe("/sites/workshop-page");
        expect(body.project.publishedAt).not.toBeNull();
      });
    await request(app.getHttpServer())
      .post(`/api/projects/${second.id}/publish`)
      .expect(201);

    await request(app.getHttpServer())
      .get("/sites/workshop-page")
      .expect(200)
      .expect("content-type", /html/)
      .expect("x-content-type-options", "nosniff")
      .expect((response) => {
        expect(response.text).toContain("Original body");
        expect(response.text).not.toContain("Other project content");
      });

    await expect(readdir(config.publishDir)).resolves.toEqual(
      expect.arrayContaining([`${first.id}.html`, `${second.id}.html`])
    );

    await request(app.getHttpServer())
      .put(`/api/projects/${first.id}`)
      .send({ name: first.name, slug: first.slug, blocks: [
        { id: "replacement", type: "text", text: "Replacement body" }
      ] })
      .expect(200);
    await request(app.getHttpServer()).post(`/api/projects/${first.id}/publish`).expect(201);

    await request(app.getHttpServer())
      .get("/sites/workshop-page")
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain("Replacement body");
        expect(response.text).not.toContain("Original body");
      });
  });

  it("invalidates both old and new public slugs until a renamed project is republished", async () => {
    const project = await createProject();
    await request(app.getHttpServer()).post(`/api/projects/${project.id}/publish`).expect(201);
    await request(app.getHttpServer()).get("/sites/workshop-page").expect(200);

    await request(app.getHttpServer())
      .put(`/api/projects/${project.id}`)
      .send({ name: project.name, slug: "renamed-page", blocks: project.blocks })
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body.publishedAt).toBeNull();
      });

    await request(app.getHttpServer()).get("/sites/workshop-page").expect(404);
    await request(app.getHttpServer()).get("/sites/renamed-page").expect(404);

    await request(app.getHttpServer()).post(`/api/projects/${project.id}/publish`).expect(201);
    await request(app.getHttpServer()).get("/sites/renamed-page").expect(200);
    await request(app.getHttpServer()).get("/sites/workshop-page").expect(404);
  });

  it("accepts unsafe URLs at save time and neutralizes them when publishing", async () => {
    const project = await createProject({ blocks: [
      { id: "unsafe", type: "button", label: "Unsafe", url: "javascript:alert(1)" }
    ] });

    await request(app.getHttpServer()).post(`/api/projects/${project.id}/publish`).expect(201);
    await request(app.getHttpServer())
      .get("/sites/workshop-page")
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain('aria-disabled="true"');
        expect(response.text).not.toContain("javascript:");
      });
  });

  it("renames a project via PATCH without changing its other fields", async () => {
    const created = await createProject();

    await request(app.getHttpServer())
      .patch(`/api/projects/${created.id}/name`)
      .send({ name: "Renamed page" })
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body.id).toBe(created.id);
        expect(body.name).toBe("Renamed page");
        expect(body.slug).toBe(created.slug);
        expect(body.blocks).toEqual(created.blocks);
      });

    await request(app.getHttpServer())
      .get(`/api/projects/${created.id}`)
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body.name).toBe("Renamed page");
      });
  });

  it("trims a renamed project name before persistence", async () => {
    const created = await createProject();

    await request(app.getHttpServer())
      .patch(`/api/projects/${created.id}/name`)
      .send({ name: "  Renamed page  " })
      .expect(200)
      .expect(({ body }: { body: ProjectResponse }) => {
        expect(body.name).toBe("Renamed page");
      });
  });

  it.each([
    ["empty name", ""],
    ["whitespace-only name", "   "]
  ])("returns the common 400 envelope when renaming with an %s", async (_description, name) => {
    const created = await createProject();

    await request(app.getHttpServer())
      .patch(`/api/projects/${created.id}/name`)
      .send({ name })
      .expect(400)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        expect(typeof body.message).toBe("string");
      });
  });

  it("returns the common not-found envelope when renaming an unknown project", async () => {
    await request(app.getHttpServer())
      .patch("/api/projects/123e4567-e89b-42d3-a456-426614174000/name")
      .send({ name: "Renamed page" })
      .expect(404, {
        statusCode: 404,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found"
      });
  });

  it("returns 404 for a site that has not been published", async () => {
    await request(app.getHttpServer())
      .get("/sites/not-published")
      .expect(404)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toMatchObject({ statusCode: 404, code: "SITE_NOT_FOUND" });
      });
  });

  describe("GET /api/projects", () => {
    it("returns empty items with default pagination metadata when no projects exist", async () => {
      await request(app.getHttpServer())
        .get("/api/projects")
        .expect(200)
        .expect(({ body }: { body: ProjectListResponse }) => {
          expect(body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
        });
    });

    it("returns items in deterministic newest-first order with total metadata", async () => {
      const first = await createProject({ name: "First", slug: "first-page" });
      const second = await createProject({ name: "Second", slug: "second-page" });
      const third = await createProject({ name: "Third", slug: "third-page" });

      await request(app.getHttpServer())
        .get("/api/projects")
        .expect(200)
        .expect(({ body }: { body: ProjectListResponse }) => {
          expect(body.page).toBe(1);
          expect(body.pageSize).toBe(20);
          expect(body.total).toBe(3);
          expect(body.items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
        });
    });

    it("paginates with the requested page and pageSize", async () => {
      await createProject({ name: "First", slug: "first-page" });
      await createProject({ name: "Second", slug: "second-page" });
      const third = await createProject({ name: "Third", slug: "third-page" });

      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ page: 1, pageSize: 2 })
        .expect(200)
        .expect(({ body }: { body: ProjectListResponse }) => {
          expect(body).toMatchObject({ page: 1, pageSize: 2, total: 3 });
          expect(body.items).toHaveLength(2);
          expect(body.items[0]?.id).toBe(third.id);
        });

      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ page: 2, pageSize: 2 })
        .expect(200)
        .expect(({ body }: { body: ProjectListResponse }) => {
          expect(body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
          expect(body.items).toHaveLength(1);
        });
    });

    it.each([
      ["zero", "0"],
      ["negative", "-1"],
      ["non-integer", "1.5"],
      ["non-numeric", "abc"]
    ])("returns the common 400 envelope for a %s page value", async (_description, value) => {
      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ page: value })
        .expect(400)
        .expect(({ body }: { body: Record<string, unknown> }) => {
          expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        });
    });

    it("returns the common 400 envelope for a pageSize above the maximum", async () => {
      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ pageSize: 51 })
        .expect(400)
        .expect(({ body }: { body: Record<string, unknown> }) => {
          expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        });
    });

    it("returns the common 400 envelope for an offset beyond the maximum supported window", async () => {
      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ page: 100000, pageSize: 50 })
        .expect(400)
        .expect(({ body }: { body: Record<string, unknown> }) => {
          expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        });
    });

    it("returns the common 400 envelope for an unsupported query parameter", async () => {
      await request(app.getHttpServer())
        .get("/api/projects")
        .query({ search: "workshop" })
        .expect(400)
        .expect(({ body }: { body: Record<string, unknown> }) => {
          expect(body).toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
        });
    });
  });

  it("returns lastSuccessfulPublishAt as null before publish and as an ISO 8601 string after", async () => {
    const project = await createProject();

    expect(project.lastSuccessfulPublishAt).toBeNull();

    const publishResponse = await request(app.getHttpServer())
      .post(`/api/projects/${project.id}/publish`)
      .expect(201);
    const published = publishResponse.body as { project: ProjectResponse; url: string };

    expect(published.project.lastSuccessfulPublishAt).not.toBeNull();
    expect(Date.parse(published.project.lastSuccessfulPublishAt as string)).not.toBeNaN();

    const loaded = await request(app.getHttpServer())
      .get(`/api/projects/${project.id}`)
      .expect(200);
    expect((loaded.body as ProjectResponse).lastSuccessfulPublishAt).toBe(
      published.project.lastSuccessfulPublishAt
    );
  });

  it("preserves lastSuccessfulPublishAt after a project update while resetting publishedAt", async () => {
    const project = await createProject();
    const publishResponse = await request(app.getHttpServer())
      .post(`/api/projects/${project.id}/publish`)
      .expect(201);
    const lastPublishTime = (publishResponse.body as { project: ProjectResponse }).project.lastSuccessfulPublishAt;

    const updateResponse = await request(app.getHttpServer())
      .put(`/api/projects/${project.id}`)
      .send({ name: project.name, slug: project.slug, blocks: project.blocks })
      .expect(200);
    const updated = updateResponse.body as ProjectResponse;

    expect(updated.publishedAt).toBeNull();
    expect(updated.lastSuccessfulPublishAt).toBe(lastPublishTime);
  });

  it("unpublishes a published page and is idempotent while leaving other output intact", async () => {
    const first = await createProject({ slug: "first-page" });
    const second = await createProject({ name: "Other", slug: "other-page", blocks: [ { id: "other", type: "text", text: "Other" } ] });

    await request(app.getHttpServer()).post(`/api/projects/${first.id}/publish`).expect(201);
    await request(app.getHttpServer()).post(`/api/projects/${second.id}/publish`).expect(201);

    // Both published
    await request(app.getHttpServer()).get(`/sites/first-page`).expect(200);
    await request(app.getHttpServer()).get(`/sites/other-page`).expect(200);

    // Unpublish the first project
    await request(app.getHttpServer()).post(`/api/projects/${first.id}/unpublish`).expect(204);

    // No longer served
    await request(app.getHttpServer()).get(`/sites/first-page`).expect(404);

    // Other project remains served
    await request(app.getHttpServer()).get(`/sites/other-page`).expect(200);

    // Second unpublish is safe
    await request(app.getHttpServer()).post(`/api/projects/${first.id}/unpublish`).expect(204);

    // Other project still served and its file remains
    await request(app.getHttpServer()).get(`/sites/other-page`).expect(200);
    await expect(readdir(config.publishDir)).resolves.toEqual(
      expect.arrayContaining([`${second.id}.html`])
    );
  });
});
