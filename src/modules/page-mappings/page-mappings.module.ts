import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PageMappingsService } from './page-mappings.service';
import { PageMappingsController } from './page-mappings.controller';
import { PageMapping } from './entities/page-mapping.entity';
import { PagePathMapping } from './entities/page-path-mapping.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PageMapping, PagePathMapping])],
  controllers: [PageMappingsController],
  providers: [PageMappingsService],
})
export class PageMappingsModule {}
