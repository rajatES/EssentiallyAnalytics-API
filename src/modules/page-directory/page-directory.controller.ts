import { Controller, Get } from '@nestjs/common';
import { PageDirectoryService } from './page-directory.service';

@Controller('v1/page-directory')
export class PageDirectoryController {
  constructor(private readonly service: PageDirectoryService) {}

  @Get()
  findAll() {
    return this.service.getDirectory();
  }
}
