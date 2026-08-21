import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import { ProviderStatusDto } from '../contracts';

@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providersService: ProvidersService) {}

  @Get()
  @ApiOkResponse({ type: ProviderStatusDto })
  async getStatus(): Promise<ProviderStatusDto> {
    return this.providersService.getStatus();
  }
}
