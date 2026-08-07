import { Module, forwardRef } from '@nestjs/common';
import { ConnectionRegistry } from './connection.registry';
import { AppWebsocketGateway } from './websocket.gateway';
import { DevicesModule } from '../devices/devices.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    DevicesModule,
    SessionsModule,
    forwardRef(() => TasksModule),
  ],
  providers: [ConnectionRegistry, AppWebsocketGateway],
  exports: [ConnectionRegistry],
})
export class WebsocketModule {}
