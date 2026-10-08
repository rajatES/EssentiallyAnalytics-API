import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StableProductionController } from './stable-production.controller';
import { StableProductionService } from './stable-production.service';
import { SpSheetsSyncService } from './sheets-sync.service';
import { SpPiece } from './entities/sp-piece.entity';
import { SpRosterPerson } from './entities/sp-roster.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SpPiece, SpRosterPerson])],
  controllers: [StableProductionController],
  providers: [StableProductionService, SpSheetsSyncService],
  exports: [StableProductionService],
})
export class StableProductionModule {}
