import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CriticalFlowController } from './critical-flow.controller';
import { CriticalFlowService } from './critical-flow.service';
import { CfSheetsSyncService } from './sheets-sync.service';
import { CfPiece } from './entities/cf-piece.entity';
import { ResourcesModule } from '../resources/resources.module';

@Module({
  imports: [TypeOrmModule.forFeature([CfPiece]), ResourcesModule],
  controllers: [CriticalFlowController],
  providers: [CriticalFlowService, CfSheetsSyncService],
  exports: [CriticalFlowService],
})
export class CriticalFlowModule {}
