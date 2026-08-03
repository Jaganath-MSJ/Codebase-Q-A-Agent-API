import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { AskDto, AskResponseDto } from '../contracts';

@ApiTags('chat')
@Controller('ask')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @ApiOkResponse({ type: AskResponseDto })
  async ask(@Body() dto: AskDto): Promise<AskResponseDto> {
    return this.chatService.ask(dto.projectId, dto.question);
  }
}
