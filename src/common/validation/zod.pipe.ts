import {
  BadRequestException,
  PipeTransform,
  Injectable,
} from '@nestjs/common';
import { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        error: 'VALIDATION_ERROR',
        details: result.error.issues,
      });
    }
    return result.data;
  }
}

export function parseOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      error: 'VALIDATION_ERROR',
      details: result.error.issues,
    });
  }
  return result.data;
}
