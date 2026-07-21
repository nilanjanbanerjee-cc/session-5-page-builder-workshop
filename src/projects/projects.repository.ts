import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import type { EditableProject, ProjectEntity } from "./project.entity";
import { validateBlocks } from "./validation/validate-blocks";

// The Prisma 7 client is generated with `@ts-nocheck`, so its exported model and
// delegate types degrade to `any` under type-checked linting. This repository is
// the single boundary that touches the generated client; it re-establishes strong
// typing by describing the persisted row and delegate surface explicitly and
// casting the untyped client exactly once.
type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  blocks: unknown;
  textColor: string | null;
  buttonColor: string | null;
  publishedAt: Date | null;
  lastSuccessfulPublishAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectData = {
  name: string;
  slug: string;
  description?: string | null;
  blocks: unknown;
  textColor?: string | null;
  buttonColor?: string | null;
  publishedAt?: Date | null;
  lastSuccessfulPublishAt?: Date | null;
};

type ProjectOrderBy = Array<{ createdAt: "desc" } | { id: "desc" }>;

type ProjectDelegate = {
  create(args: { data: ProjectData }): Promise<ProjectRow>;
  findUnique(args: { where: { id: string } | { slug: string } }): Promise<ProjectRow | null>;
  findMany(args: { orderBy: ProjectOrderBy; skip: number; take: number }): Promise<ProjectRow[]>;
  count(): Promise<number>;
  update(args: { where: { id: string }; data: Partial<ProjectData> }): Promise<ProjectRow>;
  delete(args: { where: { id: string } }): Promise<ProjectRow>;
};

function toEntity(row: ProjectRow): ProjectEntity {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    blocks: validateBlocks(row.blocks),
    textColor: row.textColor,
    buttonColor: row.buttonColor,
    publishedAt: row.publishedAt,
    lastSuccessfulPublishAt: row.lastSuccessfulPublishAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

@Injectable()
export class ProjectsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get projects(): ProjectDelegate {
    return (this.prisma as unknown as { project: ProjectDelegate }).project;
  }

  async create(input: EditableProject): Promise<ProjectEntity> {
    const row = await this.projects.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        blocks: input.blocks,
        textColor: input.textColor,
        buttonColor: input.buttonColor
      }
    });
    return toEntity(row);
  }

  async findById(id: string): Promise<ProjectEntity | null> {
    const row = await this.projects.findUnique({ where: { id } });
    return row === null ? null : toEntity(row);
  }

  async findBySlug(slug: string): Promise<ProjectEntity | null> {
    const row = await this.projects.findUnique({ where: { slug } });
    return row === null ? null : toEntity(row);
  }

  async list(skip: number, take: number): Promise<{ rows: ProjectEntity[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.projects.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take
      }),
      this.projects.count()
    ]);
    return { rows: rows.map(toEntity), total };
  }

  async update(id: string, input: EditableProject): Promise<ProjectEntity> {
    const row = await this.projects.update({
      where: { id },
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        blocks: input.blocks,
        textColor: input.textColor,
        buttonColor: input.buttonColor,
        publishedAt: null
      }
    });
    return toEntity(row);
  }

  async delete(id: string): Promise<void> {
    await this.projects.delete({ where: { id } });
  }

  async updateName(id: string, name: string): Promise<ProjectEntity> {
    const row = await this.projects.update({
      where: { id },
      data: { name }
    });
    return toEntity(row);
  }

  async markPublished(id: string, publishedAt: Date): Promise<ProjectEntity> {
    const row = await this.projects.update({
      where: { id },
      data: { publishedAt, lastSuccessfulPublishAt: publishedAt }
    });
    return toEntity(row);
  }

  async markUnpublished(id: string): Promise<ProjectEntity> {
    const row = await this.projects.update({
      where: { id },
      data: { publishedAt: null }
    });
    return toEntity(row);
  }
}
