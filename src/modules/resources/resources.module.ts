import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourcesController } from './resources.controller';
import { CombinedProductionController } from './combined-production.controller';
import { CombinedProductionService } from './combined-production.service';
import { ResourcesService } from './resources.service';
import { ResourcesSyncService } from './resources-sync.service';
import { ResourceDirectoryService } from './resource-directory.service';
import { ResPerson } from './entities/res-person.entity';
import { ResLeave } from './entities/res-leave.entity';
import { ResDivisionQuota } from './entities/res-division-quota.entity';
import { ResProfile } from './entities/res-profile.entity';
import { CfPiece } from '../critical-flow/entities/cf-piece.entity';
import { YpPiece } from '../yahoo-production/entities/yp-piece.entity';
import { YpDivisionQuota } from '../yahoo-production/entities/yp-division-quota.entity';

/**
 * People, leave and quotas shared by Critical Flow and Yahoo. The two
 * production modules import this for their rosters; the board reads their
 * piece tables directly rather than through their services, so there is no
 * module cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResPerson,
      ResLeave,
      ResDivisionQuota,
      ResProfile,
      CfPiece,
      YpPiece,
      YpDivisionQuota,
    ]),
  ],
  controllers: [ResourcesController, CombinedProductionController],
  providers: [ResourcesService, ResourcesSyncService, ResourceDirectoryService, CombinedProductionService],
  exports: [ResourceDirectoryService, CombinedProductionService],
})
export class ResourcesModule {}
