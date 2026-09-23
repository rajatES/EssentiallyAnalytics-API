import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ResourcesService } from './resources.service';
import { ResourcesSyncService } from './resources-sync.service';
import { MinRole } from '../../common/decorators/min-role.decorator';
import { UserRole } from '../auth/entities/user.entity';

@Controller('v1/resources')
export class ResourcesController {
  constructor(
    private readonly resources: ResourcesService,
    private readonly sync: ResourcesSyncService,
  ) {}

  @Get('sync-status')
  getSyncStatus() {
    return this.sync.getStatus();
  }

  @MinRole(UserRole.ADMIN)
  @Post('sync')
  async triggerSync() {
    await this.sync.sync();
    return this.sync.getStatus();
  }

  @Get('summary')
  getSummary(@Query('date') date?: string) {
    return this.resources.getSummary(date || undefined);
  }

  @Get('board')
  getBoard(@Query() query: Record<string, any>) {
    const split = (v: any): string[] | undefined => (v ? String(v).split(',') : undefined);
    return this.resources.getBoard({
      date: query.date || undefined,
      divisions: split(query.divisions),
      role: query.role || undefined,
      statuses: split(query.statuses),
      q: query.q || undefined,
    });
  }

  @Get('suggest')
  suggest(@Query() query: Record<string, any>) {
    return this.resources.suggest({
      division: String(query.division || ''),
      role: query.role || undefined,
      forPerson: query.forPerson || undefined,
      date: query.date || undefined,
    });
  }

  @Get('health')
  getHealth() {
    return this.resources.getHealth();
  }

  @Get('profiles')
  getProfiles() {
    return this.resources.getProfiles();
  }

  @MinRole(UserRole.MANAGEMENT)
  @Put('profiles')
  updateProfiles(@Body() body: any) {
    return this.resources.updateProfiles(body);
  }
}
