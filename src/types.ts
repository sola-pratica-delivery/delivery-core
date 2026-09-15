export interface UploadMetadata {
  uploadId: string;
  filename: string;
  filetype: string;
  totalSize: number;
  uploadedBytes: number;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
  rawMetadata?: Record<string, string | null>;
}

export interface UploadServiceConfig {
  storageDir: string;
  maxFileSize: number;
  minChunkSize: number;
  maxChunkSize: number;
  apiTokens: string[];
  uploadPath: string;
}

export interface AppConfig extends UploadServiceConfig {
  host: string;
  port: number;
  logLevel: string;
  onUploadComplete?: (metadata: UploadMetadata) => void | Promise<void>;
}

export interface AuthInfo {
  token: string;
}

declare module "fastify" {
  interface FastifyRequest {
    upload?: AuthInfo;
  }
}