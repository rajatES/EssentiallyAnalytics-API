import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PageMappingsService } from './page-mappings.service';
import { PageMapping } from './entities/page-mapping.entity';
import { PagePathMapping } from './entities/page-path-mapping.entity';

@Controller('page-mappings')
export class PageMappingsController {
  constructor(private readonly service: PageMappingsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() mapping: Partial<PageMapping>) {
    return this.service.create(mapping);
  }

  /**
   * Batch-update the `team` field for multiple mapping IDs at once.
   * Body: { ids: number[], team: string | null }
   * Returns the full updated mappings list.
   *
   * MUST be declared BEFORE the `:id` routes so NestJS matches the literal
   * path segment "batch" rather than treating it as a numeric :id param.
   */
  @Patch('batch/team')
  async batchUpdateTeam(@Body() body: { ids: number[]; team: string | null }) {
    const { ids, team } = body;
    if (!Array.isArray(ids) || ids.length === 0) return this.service.findAll();

    // Resolve the pageName from any of the supplied IDs, then cascade the
    // team update to ALL rows sharing that pageName.  This guarantees every
    // UTM-medium row for the page stays in sync — even if the UI only knew
    // about a subset of IDs.
    const first = await this.service.findOneById(ids[0]);
    if (first) {
      await this.service.updateTeamByPageName(first.pageName, team);
    }
    return this.service.findAll();
  }

  /**
   * Landing-page (URL pattern) mappings.
   *
   * Declared before the ':id' routes so "paths" isn't parsed as a numeric id.
   */
  @Get('paths')
  findAllPaths() {
    return this.service.findAllPaths();
  }

  @Post('paths')
  async createPath(@Body() mapping: Partial<PagePathMapping>) {
    try {
      return await this.service.createPath(mapping);
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Failed to create mapping',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('paths/batch/team')
  batchUpdatePathTeam(@Body() body: { ids: number[]; team: string | null }) {
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    return this.service.updatePathTeams(ids, body?.team ?? null);
  }

  @Patch('paths/:id')
  updatePath(
    @Param('id') id: string,
    @Body() mapping: Partial<PagePathMapping>,
  ) {
    return this.service.updatePath(+id, mapping);
  }

  @Delete('paths/:id')
  removePath(@Param('id') id: string) {
    return this.service.removePath(+id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() mapping: Partial<PageMapping>) {
    return this.service.update(+id, mapping);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importCSV(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No CSV file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const count = await this.service.importFromCSV(file.buffer);
      return {
        status: 'success',
        message: `Imported ${count} page mappings successfully.`,
      };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
