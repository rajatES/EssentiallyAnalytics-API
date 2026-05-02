import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportSportsMapping } from './entities/report-sports-mapping.entity';
import { ReportSportsMappingsService } from './report-sports-mappings.service';
import { ReportSportsMappingsController } from './report-sports-mappings.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ReportSportsMapping])],
  providers: [ReportSportsMappingsService],
  controllers: [ReportSportsMappingsController],
  exports: [TypeOrmModule],
})
export class ReportSportsMappingsModule {}
