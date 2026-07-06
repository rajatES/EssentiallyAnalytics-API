import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MsnProductionController } from './msn-production.controller';
import { MsnProductionService } from './msn-production.service';
import { SheetsSyncService } from './sheets-sync.service';
import { ReportsService } from './reports.service';
import { MsnPiece } from './entities/msn-piece.entity';
import { MsnRosterPerson } from './entities/msn-roster-person.entity';
import { MsnModerationRow } from './entities/msn-moderation-row.entity';
import { MsnReportEod } from './entities/msn-report-eod.entity';
import { MsnReportEow } from './entities/msn-report-eow.entity';
import { MsnReportMtd } from './entities/msn-report-mtd.entity';
import { MsnReportTarget } from './entities/msn-report-target.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MsnPiece,
      MsnRosterPerson,
      MsnModerationRow,
      MsnReportEod,
      MsnReportEow,
      MsnReportMtd,
      MsnReportTarget,
    ]),
  ],
  controllers: [MsnProductionController],
  providers: [MsnProductionService, SheetsSyncService, ReportsService],
  exports: [MsnProductionService],
})
export class MsnProductionModule {}
