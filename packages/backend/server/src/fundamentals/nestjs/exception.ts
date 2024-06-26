import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { GqlContextType } from '@nestjs/graphql';
import { ThrottlerException } from '@nestjs/throttler';
import { Response } from 'express';
import { of } from 'rxjs';

import {
  InternalServerError,
  TooManyRequest,
  UserFriendlyError,
} from '../error';
import { metrics } from '../metrics';

export function mapAnyError(error: any): UserFriendlyError {
  if (error instanceof UserFriendlyError) {
    return error;
  } else if (error instanceof ThrottlerException) {
    return new TooManyRequest();
  } else {
    const e = new InternalServerError();
    e.cause = error;
    return e;
  }
}

@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  logger = new Logger('GlobalExceptionFilter');
  override catch(exception: Error, host: ArgumentsHost) {
    const error = mapAnyError(exception);
    // with useGlobalFilters, the context is always HTTP
    if (host.getType<GqlContextType>() === 'graphql') {
      // let Graphql LoggerPlugin handle it
      // see '../graphql/logger-plugin.ts'
      throw error;
    } else {
      error.log('HTTP');
      metrics.controllers.counter('error').add(1, { status: error.status });
      const res = host.switchToHttp().getResponse<Response>();
      res.status(error.status).send(error.json());
      return;
    }
  }
}

export const GatewayErrorWrapper = (event: string): MethodDecorator => {
  // @ts-expect-error allow
  return (
    _target,
    _key,
    desc: TypedPropertyDescriptor<(...args: any[]) => any>
  ) => {
    const originalMethod = desc.value;
    if (!originalMethod) {
      return desc;
    }

    desc.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        const mappedError = mapAnyError(error);
        mappedError.log('Websocket');
        metrics.socketio
          .counter('error')
          .add(1, { event, status: mappedError.status });

        return {
          error: mappedError.json(),
        };
      }
    };

    return desc;
  };
};

export function mapSseError(originalError: any) {
  const error = mapAnyError(originalError);
  error.log('Sse');
  metrics.sse.counter('error').add(1, { status: error.status });
  return of({
    type: 'error' as const,
    data: error.json(),
  });
}
