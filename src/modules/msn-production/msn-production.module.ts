import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MsnProductionController } from './msn-production.controller';
import { MsnProductionService } from './msn-production.service';
import { SheetsSyncService } from './sheets-sync.service';
import { MsnSourceRow } from './entities/msn-source.entity';
import { MsnAllotmentRow } from './entities/msn-allotment.entity';

@Module({
  imports: [TypeOrmModule.forFeature([MsnSourceRow, MsnAllotmentRow])],
  controllers: [MsnProductionController],
  providers: [MsnProductionService, SheetsSyncService],
  exports: [MsnProductionService],
})
export class MsnProductionModule {}
