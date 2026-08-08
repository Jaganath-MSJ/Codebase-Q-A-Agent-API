import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

export class FileQueryDto {
  @ApiProperty({ description: 'Repo-relative path, forward slashes' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^\\]+$/, { message: 'path must use forward slashes, not backslashes' })
  path!: string;

  @ApiProperty({ description: '1-based, inclusive — the cited range to highlight' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  startLine!: number;

  @ApiProperty({ description: '1-based, inclusive — the cited range to highlight' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  endLine!: number;

  @ApiPropertyOptional({ description: 'Extra lines of surrounding context, each side', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  context?: number;
}

export class FileViewDto {
  @ApiProperty()
  path!: string;

  @ApiProperty({ description: 'The cited range being highlighted, as requested' })
  startLine!: number;

  @ApiProperty()
  endLine!: number;

  @ApiProperty({ description: '1-based line number of the first returned line' })
  contextStart!: number;

  @ApiProperty({ description: '1-based line number of the last returned line' })
  contextEnd!: number;

  @ApiProperty({ type: String, isArray: true, description: 'lines[contextStart..contextEnd], inclusive' })
  lines!: string[];
}
