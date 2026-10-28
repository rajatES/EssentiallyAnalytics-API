import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrafficPageDaily } from '../utm-analytics/entities/traffic-page-daily.entity';
import { ResourcesModule } from '../resources/resources.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({
  imports: [TypeOrmModule.forFeature([TrafficPageDaily]), ResourcesModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
