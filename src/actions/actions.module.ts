import { Module } from '@nestjs/common';
import { ActionsService } from './actions.service';

@Module({
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
