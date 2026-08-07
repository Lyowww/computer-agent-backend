import { Module } from '@nestjs/common';
import { ScreenshotsService } from './screenshots.service';

@Module({
  providers: [ScreenshotsService],
  exports: [ScreenshotsService],
})
export class ScreenshotsModule {}
