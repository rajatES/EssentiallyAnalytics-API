import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { EmailReportsService } from './email-reports.service';
import { MinRole } from '../../common/decorators/min-role.decorator';
import { UserRole } from '../auth/entities/user.entity';

@Controller('v1/email-reports')
export class EmailReportsController {
  constructor(private readonly service: EmailReportsService) {}

  @Get('recipients')
  async listRecipients() {
    return this.service.listRecipients();
  }

  @MinRole(UserRole.MANAGEMENT)
  @Post('recipients')
  async addRecipient(@Body() body: { email: string }) {
    const email = body?.email?.trim();
    if (!email || !this.isValidEmail(email)) {
      throw new BadRequestException('Invalid email address');
    }
    return this.service.addRecipient(email);
  }

  @MinRole(UserRole.MANAGEMENT)
  @Delete('recipients/:id')
  async removeRecipient(@Param('id') id: string) {
    await this.service.removeRecipient(Number(id));
    return { success: true };
  }

  @MinRole(UserRole.MANAGEMENT)
  @Post('send-test')
  async sendTestReport() {
    return this.service.sendTestReport();
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
