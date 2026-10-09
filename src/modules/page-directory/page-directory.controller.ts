import { Controller, Get } from '@nestjs/common';
import { PageDirectoryService } from './page-directory.service';
import { Section } from '../../common/decorators/section.decorator';

@Controller('v1/page-directory')
@Section('sm')
export class PageDirectoryController {
  constructor(private readonly service: PageDirectoryService) {}

  @Get()
  findAll() {
    return this.service.getDirectory();
  }
}
