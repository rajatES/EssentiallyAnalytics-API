import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourcesModule } from '../resources/resources.module';
import { ResPerson } from '../resources/entities/res-person.entity';
import { WeeklyReportController } from './weekly-report.controller';
import { WeeklyReportService } from './weekly-report.service';

@Module({
  imports: [ResourcesModule, TypeOrmModule.forFeature([ResPerson])],
  controllers: [WeeklyReportController],
  providers: [WeeklyReportService],
})
export class WeeklyReportModule {}
