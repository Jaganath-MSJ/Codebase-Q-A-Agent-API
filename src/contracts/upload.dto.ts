import { ApiProperty } from '@nestjs/swagger';

export class UploadResultDto {
  @ApiProperty({ description: 'Pass this as sourceRef when creating a zip_upload project' })
  uploadId!: string;

  @ApiProperty()
  sizeBytes!: number;
}
