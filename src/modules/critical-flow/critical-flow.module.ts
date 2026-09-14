import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CriticalFlowController } from './critical-flow.controller';
import { CriticalFlowService } from './critical-flow.service';
import { CfSheetsSyncService } from './sheets-sync.service';
import { ScheduleSyncService } from './schedule-sync.service';
import { ResourcesService } from './resources.service';
import { CfPiece } from './entities/cf-piece.entity';
import { CfRosterPerson } from './entities/cf-roster-person.entity';
import { CfSchedulePerson } from './entities/cf-schedule-person.entity';
import { CfLeave } from './entities/cf-leave.entity';
import { CfDivisionQuota } from './entities/cf-division-quota.entity';
import { CfResourceProfile } from './entities/cf-resource-profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CfPiece,
      CfRosterPerson,
      CfSchedulePerson,
      CfLeave,
      CfDivisionQuota,
      CfResourceProfile,
    ]),
  ],
  controllers: [CriticalFlowController],
  providers: [
    CriticalFlowService,
    CfSheetsSyncService,
    ScheduleSyncService,
    ResourcesService,
  ],
  exports: [CriticalFlowService, ResourcesService],
})
export class CriticalFlowModule {}
