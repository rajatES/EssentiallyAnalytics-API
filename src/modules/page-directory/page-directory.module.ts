import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PageDirectoryService } from './page-directory.service';
import { PageDirectoryController } from './page-directory.controller';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { RevenueMapping } from '../revenue/entities/revenue-mapping.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SocialProfile, RevenueMapping, PageMapping]),
  ],
  controllers: [PageDirectoryController],
  providers: [PageDirectoryService],
})
export class PageDirectoryModule {}
