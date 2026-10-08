import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourcesModule } from '../resources/resources.module';
import { ResPerson } from '../resources/entities/res-person.entity';
import { SpRosterPerson } from '../stable-production/entities/sp-roster.entity';
import { WeeklyReportController } from './weekly-report.controller';
import { WeeklyReportService } from './weekly-report.service';

@Module({
  imports: [
    ResourcesModule,
    TypeOrmModule.forFeature([ResPerson, SpRosterPerson]),
  ],
  controllers: [WeeklyReportController],
  providers: [WeeklyReportService],
})
export class WeeklyReportModule {}
