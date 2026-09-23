import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MinRole } from '../../common/decorators/min-role.decorator';
import { UserRole } from './entities/user.entity';
import { UpdateRoleDto } from '../../common/dto/signup.dto';

/** Access management — the superadmin's page. */
@Controller('api/users')
@MinRole(UserRole.SUPERADMIN)
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  list() {
    return this.authService.listUsers();
  }

  @Patch(':id/role')
  setRole(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto) {
    return this.authService.setRole(id, body.role);
  }
}
