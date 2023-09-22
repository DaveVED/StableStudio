export interface ModelsConfig {
    modelId: string,
    modelName: string,
    endpointName: string
};

export interface TextPrompt {
    text: string,
    weight?: number
};

export enum GuidancePreset {
    NONE = "NONE",
    SIMPLE = "SIMPLE",
    FAST_BLUE = "FAST_BLUE",
    FAST_GREEN = "FAST_GREEN",
    SLOW = "SLOW",
    SLOWER = "SLOWER",
    SLOWEST = "SLOWEST"
};

export enum InitImageMode {
    IMAGE_STRENGTH = "IMAGE_STRENGTH",
    STEP_SCHEDULE = "STEP_SCHEDULE"
};

export enum MaskSource {
    MASK_IMAGE_BLACK = "MASK_IMAGE_BLACK",
    MASK_IMAGE_WHITE = "MASK_IMAGE_WHITE",
    INIT_IMAGE_ALPHA = "INIT_IMAGE_ALPHA"
};

export interface GenerationRequest {
    height: number,
    width: number,
    text_prompts: TextPrompt[],
    cfg_scale: number,
    clip_guidance_preset?: GuidancePreset,
    sampler?: string,
    samples: number,
    seed: number,
    steps: number,
    style_preset?: string,
    extras?: any,

    // image to image specific options
    init_image?: string,
    init_image_mode?: InitImageMode,
    image_strength?: number,
    step_schedule_start?: number,
    step_schedule_end?: number,

    // image to image with masking specific options
    mask_source?: MaskSource,
    mask_image?: string
};

export interface BinaryArtifact {
    seed: number,
    base64: string,
    finishReason: string
};

export interface GenerationErrorResponse {
    id: string,
    name: string,
    message: string
};

export interface GenerationResponse {
    result: string,
    artifacts: BinaryArtifact[],
    error: GenerationErrorResponse
};
