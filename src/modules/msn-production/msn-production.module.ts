import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MsnProductionController } from './msn-production.controller';
import { MsnProductionService } from './msn-production.service';
import { SheetsSyncService } from './sheets-sync.service';
import { MsnPiece } from './entities/msn-piece.entity';
import { MsnRosterPerson } from './entities/msn-roster-person.entity';
import { MsnModerationRow } from './entities/msn-moderation-row.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([MsnPiece, MsnRosterPerson, MsnModerationRow]),
  ],
  controllers: [MsnProductionController],
  providers: [MsnProductionService, SheetsSyncService],
  exports: [MsnProductionService],
})
export class MsnProductionModule {}
