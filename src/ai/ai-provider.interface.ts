export interface SceneDetection {
  startTimeSeconds: number;
  endTimeSeconds: number;
  description: string;
  confidence: number;
}

export interface VideoAnalysisResult {
  summary: string;
  tags: string[];
  scenes: SceneDetection[];
  transcript?: string;
  suggestedChapters: Array<{ title: string; timestamp: number }>;
  tokensUsed: {
    input: number;
    output: number;
  };
}

export interface AIProvider {
  readonly name: string;
  analyzeVideo(filePath: string, metadata: { duration: number; filename: string }): Promise<VideoAnalysisResult>;
  generateSummary(transcriptOrDescription: string): Promise<{ summary: string; tokensUsed: { input: number; output: number } }>;
  detectScenes(metadata: { duration: number }): Promise<SceneDetection[]>;
}
