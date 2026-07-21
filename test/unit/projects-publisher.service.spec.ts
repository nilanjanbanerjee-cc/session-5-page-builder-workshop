jest.mock("../../src/projects/projects.repository", () => ({
  ProjectsRepository: class ProjectsRepository {}
}));
jest.mock("../../src/publisher/publisher.service", () => ({
  PublisherService: class PublisherService {}
}));

import type { ProjectEntity } from "../../src/projects/project.entity";
import type { ProjectsRepository } from "../../src/projects/projects.repository";
import type { PublisherService } from "../../src/publisher/publisher.service";
import { ProjectsService } from "../../src/projects/projects.service";

const baseProject: ProjectEntity = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "Test page",
  slug: "test-page",
  description: null,
  textColor: null,
  buttonColor: null,
  blocks: [],
  publishedAt: null,
  lastSuccessfulPublishAt: null,
  createdAt: new Date(),
  updatedAt: new Date()
};

const publishTime = new Date("2026-07-14T12:00:00.000Z");

function makeService(
  publisherPublish: () => Promise<string>,
  markPublished: (id: string, at: Date) => Promise<ProjectEntity>
): ProjectsService {
  const repository = {
    findById: () => Promise.resolve(baseProject),
    markPublished
  } as unknown as ProjectsRepository;
  const publisher = { publish: publisherPublish } as unknown as PublisherService;
  return new ProjectsService(repository, publisher);
}

describe("ProjectsService.publish", () => {
  it("stores lastSuccessfulPublishAt after a successful publish", async () => {
    const published = { ...baseProject, publishedAt: publishTime, lastSuccessfulPublishAt: publishTime };
    const markPublished = jest.fn().mockResolvedValue(published);
    const service = makeService(() => Promise.resolve("/some/path.html"), markPublished);

    const result = await service.publish(baseProject.id);

    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(result.project.lastSuccessfulPublishAt).toEqual(publishTime);
    expect(result.url).toBe(`/sites/${baseProject.slug}`);
  });

  it("does not call markPublished when the publisher throws", async () => {
    const markPublished = jest.fn();
    const service = makeService(
      () => Promise.reject(new Error("I/O failure")),
      markPublished
    );

    await expect(service.publish(baseProject.id)).rejects.toThrow("I/O failure");
    expect(markPublished).not.toHaveBeenCalled();
  });
});

describe("ProjectsService.unpublish", () => {
  it("calls publisher.unpublish and marks unpublished", async () => {
    const markUnpublished = jest.fn().mockResolvedValue({ ...baseProject, publishedAt: null });
    const repository = {
      findById: () => Promise.resolve({ ...baseProject, publishedAt: new Date() }),
      markUnpublished
    } as unknown as ProjectsRepository;
    const publisher = { unpublish: jest.fn().mockResolvedValue(undefined) } as unknown as PublisherService;
    const service = new ProjectsService(repository, publisher);

    await service.unpublish(baseProject.id);

    expect((publisher.unpublish as jest.Mock).mock.calls.length).toBe(1);
    expect(markUnpublished).toHaveBeenCalledTimes(1);
  });

  it("does not mark unpublished when publisher.unpublish throws", async () => {
    const markUnpublished = jest.fn();
    const repository = {
      findById: () => Promise.resolve({ ...baseProject, publishedAt: new Date() }),
      markUnpublished
    } as unknown as ProjectsRepository;
    const publisher = { unpublish: jest.fn().mockRejectedValue(new Error("IO")) } as unknown as PublisherService;
    const service = new ProjectsService(repository, publisher);

    await expect(service.unpublish(baseProject.id)).rejects.toThrow("IO");
    expect(markUnpublished).not.toHaveBeenCalled();
  });
});
