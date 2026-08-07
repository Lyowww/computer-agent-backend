import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CurrentUser, type AuthUser } from '../common/guards/auth.guards';
import { ZodValidationPipe } from '../common/validation/zod.pipe';
import {
  createTaskSchema,
  type CreateTaskDto,
} from '../common/validation/schemas';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTaskSchema)) dto: CreateTaskDto,
  ) {
    return this.tasksService.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tasksService.list(user.userId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasksService.getById(user.userId, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasksService.cancel(user.userId, id);
  }
}
