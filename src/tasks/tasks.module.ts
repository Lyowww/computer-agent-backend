import { Module, forwardRef } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { DevicesModule } from '../devices/devices.module';
import { ActionsModule } from '../actions/actions.module';
import { AiModule } from '../ai/ai.module';
import { ScreenshotsModule } from '../screenshots/screenshots.module';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [
    DevicesModule,
    ActionsModule,
    AiModule,
    ScreenshotsModule,
    forwardRef(() => WebsocketModule),
  ],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
