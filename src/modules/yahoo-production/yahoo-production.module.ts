import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YahooProductionController } from './yahoo-production.controller';
import { YahooProductionService } from './yahoo-production.service';
import { YpSheetsSyncService } from './sheets-sync.service';
import { YpPiece } from './entities/yp-piece.entity';
import { YpDivisionQuota } from './entities/yp-division-quota.entity';
import { ResourcesModule } from '../resources/resources.module';

@Module({
  imports: [TypeOrmModule.forFeature([YpPiece, YpDivisionQuota]), ResourcesModule],
  controllers: [YahooProductionController],
  providers: [YahooProductionService, YpSheetsSyncService],
  exports: [YahooProductionService],
})
export class YahooProductionModule {}
