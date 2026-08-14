import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PageMapping } from './entities/page-mapping.entity';
import { PagePathMapping } from './entities/page-path-mapping.entity';
import { Readable } from 'stream';
import * as readline from 'readline';

@Injectable()
export class PageMappingsService {
  constructor(
    @InjectRepository(PageMapping)
    private mappingRepository: Repository<PageMapping>,
    @InjectRepository(PagePathMapping)
    private pathRepository: Repository<PagePathMapping>,
  ) {}

  // ── Landing-page (URL pattern) mappings ──────────────────────────────
  // Separate from the UTM mappings above rather than folded into them: these
  // match a glob instead of an exact medium, and they are not platform-scoped.

  findAllPaths() {
    return this.pathRepository.find({
      order: { priority: 'DESC', pattern: 'ASC' },
    });
  }

  private normalizePath(partial: Partial<PagePathMapping>) {
    const out: Partial<PagePathMapping> = { ...partial };
    if (typeof out.pattern === 'string') {
      let p = out.pattern.trim();
      // Accept a full URL pasted from the browser and keep only the path.
      const asUrl = p.match(/^https?:\/\/[^/]+(\/.*)$/i);
      if (asUrl) p = asUrl[1];
      if (p && !p.startsWith('/') && !p.startsWith('*')) p = `/${p}`;
      out.pattern = p.split(/[?#]/)[0];
    }
    if ('team' in out) {
      const t = out.team;
      out.team = typeof t === 'string' && t.trim() ? t.trim() : null;
    }
    if (typeof out.pageName === 'string') out.pageName = out.pageName.trim();
    if (typeof out.category === 'string') {
      out.category = out.category.trim() || 'Uncategorized';
    }
    return out;
  }

  async createPath(partial: Partial<PagePathMapping>) {
    const data = this.normalizePath(partial);
    if (!data.pattern) throw new Error('Pattern is required');
    if (!data.pageName) throw new Error('Page name is required');
    return this.pathRepository.save(this.pathRepository.create(data));
  }

  async updatePath(id: number, partial: Partial<PagePathMapping>) {
    await this.pathRepository.update(id, this.normalizePath(partial));
    return this.pathRepository.findOneBy({ id });
  }

  async removePath(id: number) {
    await this.pathRepository.delete(id);
    return { deleted: true };
  }

  /** Batch team assignment, mirroring the UTM mappings' batch endpoint. */
  async updatePathTeams(ids: number[], team: string | null) {
    const normalized = typeof team === 'string' && team.trim() ? team.trim() : null;
    if (ids.length) {
      await this.pathRepository
        .createQueryBuilder()
        .update()
        .set({ team: normalized })
        .whereInIds(ids)
        .execute();
    }
    return this.findAllPaths();
  }

  async findAll() {
    // One-shot cleanup: normalise any empty-string team values to NULL.
    // Previous frontend code sometimes sent "" or undefined instead of null,
    // leaving rows that look "assigned" but group separately from real nulls.
    await this.mappingRepository
      .createQueryBuilder()
      .update()
      .set({ team: null })
      .where("team = ''")
      .orWhere("TRIM(team) = ''")
      .execute();

    return this.mappingRepository.find({
      order: { category: 'ASC', pageName: 'ASC' },
    });
  }

  create(mapping: Partial<PageMapping>) {
    const newMapping = this.mappingRepository.create(mapping);
    return this.mappingRepository.save(newMapping);
  }

  async update(id: number, partial: Partial<PageMapping>) {
    // Normalise the team value: empty strings, whitespace-only, and undefined
    // should all be stored as null (= "Unassigned" in the UI).  Without this,
    // TypeORM skips `undefined` fields entirely (no DB write) and stores `""`
    // as a non-null string that doesn't group with null.
    if ('team' in partial) {
      const t = partial.team;
      partial.team = typeof t === 'string' && t.trim() ? t.trim() : null;
    }
    await this.mappingRepository.update(id, partial);

    // If team was changed, cascade to ALL rows with the same pageName so that
    // a page with multiple UTM-medium rows always has a consistent team value.
    if ('team' in partial) {
      const row = await this.mappingRepository.findOneBy({ id });
      if (row) {
        await this.updateTeamByPageName(row.pageName, partial.team ?? null);
      }
    }

    return this.mappingRepository.findOneBy({ id });
  }

  /**
   * Update the team for ALL mapping rows that share the given pageName.
   * This is the single source of truth for team assignment — it guarantees
   * every row for a page always has the same team value.
   */
  async updateTeamByPageName(pageName: string, team: string | null) {
    const normalizedTeam =
      typeof team === 'string' && team.trim() ? team.trim() : null;
    await this.mappingRepository
      .createQueryBuilder()
      .update()
      .set({ team: normalizedTeam })
      .where('"pageName" = :pageName', { pageName })
      .execute();
  }

  async findOneById(id: number) {
    return this.mappingRepository.findOneBy({ id });
  }

  async remove(id: number) {
    await this.mappingRepository.delete(id);
    return { deleted: true };
  }

  async importFromCSV(fileBuffer: Buffer) {
    const fileStream = Readable.from(fileBuffer);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isHeader = true;
    const mappings: Partial<PageMapping>[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      if (isHeader) {
        isHeader = false;
        continue;
      }

      const values = this.parseCSVLine(line);

      if (values.length >= 6) {
        // Support both old format (no team) and new format (with team as 3rd col)
        // Old: id, category, platform, pageName, utmSource, utmMediums
        // New: id, category, team, platform, pageName, utmSource, utmMediums
        let category: string,
          team: string | null,
          platform: string,
          pageName: string,
          utmSource: string,
          utmMediumsStr: string;

        if (values.length >= 7) {
          // New format: team is 3rd column
          [, category, team, platform, pageName, utmSource, utmMediumsStr] =
            values;
        } else {
          // Old format: no team column
          [, category, platform, pageName, utmSource, utmMediumsStr] = values;
          team = null;
        }

        let cleanedMediumsStr = utmMediumsStr || '';
        cleanedMediumsStr = cleanedMediumsStr.replace(/^\{|\}$/g, '');

        const mediumsArray = cleanedMediumsStr
          .split(',')
          .map((m) => {
            let trimmed = m.trim();

            if (trimmed.includes('utm_medium=')) {
              const paramString = trimmed.includes('?')
                ? trimmed.substring(trimmed.indexOf('?'))
                : trimmed;
              const urlParams = new URLSearchParams(paramString);
              trimmed = urlParams.get('utm_medium') || trimmed;
            }
            return trimmed;
          })
          .filter(Boolean);

        mappings.push({
          category: category?.trim(),
          team: team?.trim() || null,
          platform: platform?.trim(),
          pageName: pageName?.trim(),
          utmSource: utmSource?.trim(),
          utmMediums: mediumsArray,
        });
      }
    }

    if (mappings.length > 0) {
      await this.mappingRepository.save(mappings);
    }

    return mappings.length;
  }

  private parseCSVLine(text: string): string[] {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        inQuotes = !inQuotes;
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        if (field.startsWith('"') && field.endsWith('"'))
          field = field.slice(1, -1);
        result.push(field);
        start = i + 1;
      }
    }
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"'))
      lastField = lastField.slice(1, -1);
    result.push(lastField);
    return result;
  }
}
