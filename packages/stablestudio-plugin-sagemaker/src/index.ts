import * as StableStudio from "@stability/stablestudio-plugin";

import {
  SageMakerRuntimeClient,
  InvokeEndpointCommandInput,
  InvokeEndpointCommand
} from "@aws-sdk/client-sagemaker-runtime";

import {
  DynamoDBClient,
  PutItemCommandInput,
  PutItemCommand,
  QueryCommandInput,
  QueryCommand,
  DeleteItemCommandInput,
  DeleteItemCommand
} from "@aws-sdk/client-dynamodb";

import {
  S3Client,
  PutObjectCommandInput, 
  PutObjectCommand,
  GetObjectCommandInput,
  GetObjectCommand,
  ObjectIdentifier,
  DeleteObjectsCommandInput,
  DeleteObjectsCommand
} from "@aws-sdk/client-s3";

import * as Api from "./api";
import { CognitoIdentityClient, GetIdCommand, GetIdCommandInput, GetOpenIdTokenCommandInput } from "@aws-sdk/client-cognito-identity";
import { CognitoIdentityCredentialProvider, CognitoIdentityCredentials, fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";

const getStableDiffusionDefaultCount = () => 1;
const getStableDiffusionDefaultInputFromPrompt = (prompt: string) => ({
    prompts: [
      {
        text: prompt,
        weight: 1,
      },
  
      {
        text: "",
        weight: -0.75,
      },
    ],

    sampler: { id: "0", name: "DDIM" },
    style: "enhance",
  
    width: 1024,
    height: 1024,
  
    cfgScale: 7,
    steps: 50,
});

async function base64ToBlob(base64: string, contentType = ""): Promise<Blob> {
  const res = await fetch(`data:${contentType};base64,${base64}`);
  return await res.blob();
};

async function getIdentityId(region:string, identityPoolId: string){
  const client = new CognitoIdentityClient({region: region});

  console.info(client.config.credentials);

  return "";
}

export const createPlugin = StableStudio.createPlugin<{
    settings: {
        modelsJson: StableStudio.PluginSettingString;
        region: StableStudio.PluginSettingString;
        cognitoIdentityPoolId: StableStudio.PluginSettingString;
        storeGenerations: StableStudio.PluginSettingBoolean;
        generationsTable: StableStudio.PluginSettingString;
        generationsBucket: StableStudio.PluginSettingString;
        projectId: StableStudio.PluginSettingString;
    };
  }>(({ context, get, set }) => ({

    manifest: {
        name: "Amazon SageMaker Plugin",
        author: "Giuseppe Angelo Porcelli",
        link: "https://www.linkedin.com/in/giuporcelli/",
        icon: "",
        version: "0.0.1",
        license: "MIT",
        description: "A plugin that runs Stable Diffusion inference by invoking Amazon SageMaker endpoints.",
    },

    createStableDiffusionImages: async (options) => {

        // Loading configuration.

        var modelsJsonString = get().settings.modelsJson.value
        if (!modelsJsonString) {
            throw new Error("Model configuration JSON is required.");
        }
        var modelsJson:Api.ModelsConfig[] = JSON.parse(modelsJsonString);
        
        var modelToInvoke = modelsJson.find(m => m.modelId==options?.input?.model);
        if (!modelToInvoke){
            throw new Error("Unable to select the model to invoke.");
        }

        var region = get().settings.region.value
        if (!region) {
          throw new Error("AWS Region setting is required.");
        }

        var identityPoolId = get().settings.cognitoIdentityPoolId.value
        if (!identityPoolId) {
          throw new Error("AWS Cognito identity pool ID setting is required.");
        }

        const count = options?.count ?? getStableDiffusionDefaultCount();
        const defaultStableDiffusionInput =
          getStableDiffusionDefaultInputFromPrompt(
            context.getStableDiffusionRandomPrompt()
          );

        const input = {
          ...defaultStableDiffusionInput,
          ...options?.input,
        };

        const width = input.width ?? defaultStableDiffusionInput.width;
        const height = input.height ?? defaultStableDiffusionInput.height;
        const cfgScale = input.cfgScale ?? defaultStableDiffusionInput.cfgScale;
        const sampler = input.sampler.name ?? defaultStableDiffusionInput.sampler.name;
        const style = input.style ?? defaultStableDiffusionInput.style;

        // Generating images.

        const smRuntimeClient = new SageMakerRuntimeClient({ region: region, credentials: fromCognitoIdentityPool({
            identityPoolId: identityPoolId,
            client: new CognitoIdentityClient({region: region})
          }) 
        });

        var prompts:Api.TextPrompt[] = input.prompts?.map(
          (sdPrompt) => {
            return {
              text: sdPrompt.text ?? context.getStableDiffusionRandomPrompt(),
              weight: sdPrompt.weight
            }
          }
        ) ?? [];

        let generation_id = crypto.randomUUID();
        let returnImages:StableStudio.StableDiffusionImages = {
          id: generation_id,
          images: []
        };
        let base64Images:string[] = [];

        for (let countIndex=0; countIndex<count; countIndex++){
          var generationRequest:Api.GenerationRequest = {
            height: height,
            width: width,
            text_prompts: prompts,
            cfg_scale: cfgScale,
            //clip_guidance_preset: Api.GuidancePreset.NONE,
            sampler: sampler,
            samples: 1, // forcing to generate 1 image for each request;
            seed: (input.seed ?? 0) + countIndex, // incrementing seed
            steps: input.steps,
            style_preset: style,
            //extras: undefined,
          };

          const smInvokeEndpointInput:InvokeEndpointCommandInput = {
            EndpointName: modelToInvoke.endpointName,
            Body: JSON.stringify(generationRequest),
            ContentType: "application/json",
            Accept: "application/json;png",
            InferenceId: crypto.randomUUID()
          };

          const smInvokeEndpointCommand = new InvokeEndpointCommand(smInvokeEndpointInput);
          const smInvokeEndpointResponse = await smRuntimeClient.send(smInvokeEndpointCommand);

          const generationResponse:Api.GenerationResponse = JSON.parse(Buffer.from(smInvokeEndpointResponse.Body).toString());

          let imageBlobs:Blob[] = [];
          for (let i = 0; i < generationResponse.artifacts.length; i++){
            base64Images.push(generationResponse.artifacts[i].base64);
            var tmp = await base64ToBlob(generationResponse.artifacts[i].base64, "image/png");
            imageBlobs.push(tmp);
          }

          let generatedImages:StableStudio.StableDiffusionImage[] = [];
          generatedImages = generationResponse.artifacts.map(
            (artifact, index) => {
              const image_id = crypto.randomUUID();
              return {
                id: image_id,
                blob: imageBlobs[index],
                input: input
              }
            });
          
          generatedImages.forEach(generatedImage => returnImages.images?.push(generatedImage));
        }

        // Saving generated images.

        const projectID = get().settings.projectId.value;
        const ddbTableName = get().settings.generationsTable.value;
        const s3BucketName = get().settings.generationsBucket.value;

        if (returnImages.images){

          const ddbClient = new DynamoDBClient({ region: region, credentials: fromCognitoIdentityPool({
            identityPoolId: identityPoolId,
            client: new CognitoIdentityClient({region: region}) }) 
          });
  
          const s3Client = new S3Client({ region: region, credentials: fromCognitoIdentityPool({
            identityPoolId: identityPoolId,
            client: new CognitoIdentityClient({region: region}) }) 
          });

          let s3ObjectKeys:string[] = [];

          for (let i = 0; i<returnImages.images.length; i++){
            const s3ObjectKey = projectID + "/" + generation_id + "/" + returnImages.images[i].id + ".png";
            s3ObjectKeys.push(s3ObjectKey);

            let s3PutObjectCommandInput:PutObjectCommandInput = {
              Bucket: s3BucketName,
              Key: s3ObjectKey,
              Body: base64Images[i],
              ContentEncoding: 'base64',
              ContentType: 'image/png'
            };

            let s3PutObjectCommand = new PutObjectCommand(s3PutObjectCommandInput);
            await s3Client.send(s3PutObjectCommand);
          }

          let ddbPutItemCommandInput:PutItemCommandInput = {
            TableName: ddbTableName,
            Item: {
              project_id: {
                S: projectID ?? ""
              },
              generation_id: {
                S: returnImages.id
              },
              input_obj: {
                S: JSON.stringify(input)
              },
              s3_object_keys : {
                S: JSON.stringify(s3ObjectKeys)
              }
            }
          };
  
          let ddbPutItemCommand = new PutItemCommand(ddbPutItemCommandInput);
          await ddbClient.send(ddbPutItemCommand);
        }

        return returnImages;
    },

    getStableDiffusionDefaultCount: () => {
      return 1;
    },

    getStableDiffusionDefaultInput: () => {
      var modelsJsonString = get().settings.modelsJson.value
      let modelToSet = undefined;
      if (modelsJsonString) {
        const modelsJson:Api.ModelsConfig[] = JSON.parse(modelsJsonString);
        modelToSet = modelsJson[0].modelId;
      }

      var defaultInput:StableStudio.StableDiffusionInput = {
        model: modelToSet,
        sampler: { id: "0", name: "DDIM" },
        style: "enhance",
        width: 1024,
        height: 1024,
        cfgScale: 7,
        steps: 50,
      };

      return defaultInput;

    },

    getStableDiffusionExistingImages: async (options) => {
      //const limit = options?.limit ?? 10;
      const limit = 3;
      if (limit <= 0) return [];

      // Checking if the plugin is configured to store the generations.
      const storeGenerations = get().settings.storeGenerations.value;

      if (storeGenerations){

        let identityPoolId = get().settings.cognitoIdentityPoolId.value
        if (!identityPoolId) {
          throw new Error("AWS Cognito identity pool ID setting is required.");
        }

        let region = get().settings.region.value
        if (!region) {
          throw new Error("AWS Region setting is required.");
        }

        let ddbClient = new DynamoDBClient({ region: region, credentials: fromCognitoIdentityPool({
            identityPoolId: identityPoolId,
            client: new CognitoIdentityClient({region: region})
          })
        });

        let s3Client = new S3Client({ region: region, credentials: fromCognitoIdentityPool({
          identityPoolId: identityPoolId,
          client: new CognitoIdentityClient({region: region}) }) 
        });

        const creds = await <Promise<CognitoIdentityCredentials>>s3Client.config.credentials();
        const identityId = creds.identityId;
        console.info("Cognito Identity ID: " + identityId);

        const currentProjectId = get().settings.projectId.value;
        if (!currentProjectId || currentProjectId === ""){
          localStorage.setItem("stablestudio-sagemaker-project-id", identityId || crypto.randomUUID());
        }

        const projectID = get().settings.projectId.value;
        console.info("Project ID: " + projectID);

        let ddbTableName = get().settings.generationsTable.value;
        let s3BucketName = get().settings.generationsBucket.value;

        let ddbQueryCommandInput:QueryCommandInput = {
          TableName: ddbTableName,
          KeyConditionExpression: 'project_id = :projectId',
          ExpressionAttributeValues: {
              ':projectId': {
                "S": projectID ?? ""
              }
          },
          Limit: limit
        };

        if (options?.exclusiveStartImageID) {
          ddbQueryCommandInput.ExclusiveStartKey = {
            "project_id":{
              "S": projectID ?? ""
            },
            "generation_id":{
              "S": options?.exclusiveStartImageID
            }
          }
        }

        let images:StableStudio.StableDiffusionImages[] = [];

        let ddbQueryCommand = new QueryCommand(ddbQueryCommandInput);
        let commandOutput = await ddbClient.send(ddbQueryCommand);
        
        if (commandOutput.Count && commandOutput.Count > 0){
          if (commandOutput.Items){
            let excStartImageId = commandOutput.LastEvaluatedKey ? commandOutput.LastEvaluatedKey["generation_id"].S : undefined;

            for (let i=0; i<commandOutput.Items.length; i++){
              const item = commandOutput.Items[i];

              let sdImagesItem:StableStudio.StableDiffusionImages = {
                id: item["generation_id"].S ?? "",
                exclusiveStartImageID: excStartImageId,
              };

              const inputObjJson = item["input_obj"].S;
              let inputObj = inputObjJson ? JSON.parse(inputObjJson) : undefined;

              sdImagesItem.images = [];

              let s3ObjectKeys = JSON.parse(item["s3_object_keys"].S ?? "[]");

              for (let i=0; i<s3ObjectKeys.length; i++){
                const objectKey = s3ObjectKeys[i];
                //let imgId = objectKey.substring(objectKey.lastIndexOf('/') + 1 , (objectKey.lastIndexOf('.')));
                
                const getObjectCommandInput:GetObjectCommandInput = {
                  Bucket: s3BucketName,
                  Key: objectKey
                };
            
                const getObjectCommand = new GetObjectCommand(getObjectCommandInput);
                const getObjectResult = await s3Client.send(getObjectCommand);
                
                let blobResult:Blob = new Blob();
                if (getObjectResult.Body){
                  const stringResultBody = await getObjectResult.Body?.transformToString("utf-8");
                  blobResult = await base64ToBlob(stringResultBody, "image/png");
                }

                let sdImage:StableStudio.StableDiffusionImage = {
                  id: objectKey,
                  input: inputObj,
                  blob: blobResult
                };
                sdImagesItem.images.push(sdImage);
              }

              images.push(sdImagesItem);
            }
          }
        }

        return images;
      }
      else {
        console.info("StableStudio is configured not to store the generated images.");
      }

      return [];
    },

    deleteStableDiffusionImages: async (options) => {
      const storeGenerations = get().settings.storeGenerations.value;
      const projectID = get().settings.projectId.value;

      if (storeGenerations && projectID){
        if (options?.imageIDs && options?.imageIDs.length > 0){
          
          const imageIds = options?.imageIDs;          
          const generationId = imageIds[0].split("/")[1];

          const identityPoolId = get().settings.cognitoIdentityPoolId.value
          if (!identityPoolId) {
            throw new Error("AWS Cognito identity pool ID setting is required.");
          }

          const region = get().settings.region.value
          if (!region) {
            throw new Error("AWS Region setting is required.");
          }

          const ddbTableName = get().settings.generationsTable.value;
          const s3BucketName = get().settings.generationsBucket.value;        

          // Deleting S3 objects.
          const s3Client = new S3Client({ region: region, credentials: fromCognitoIdentityPool({
            identityPoolId: identityPoolId,
            client: new CognitoIdentityClient({region: region}) }) 
          });

          const s3ObjectIdentifiers:ObjectIdentifier[] = imageIds.map(id => {
            return {
              Key: id
            }
          });

          const s3DeleteObjectsCommandInput:DeleteObjectsCommandInput = {
            Bucket: s3BucketName,
            Delete: {
              Objects: s3ObjectIdentifiers
            }
          };

          const s3DeleteObjectsCommand = new DeleteObjectsCommand(s3DeleteObjectsCommandInput);
          const s3DeleteResult = await s3Client.send(s3DeleteObjectsCommand);

          if (s3DeleteResult.Deleted && s3DeleteResult.Deleted.length == imageIds.length){
            // Deleting DDB items.
            const ddbClient = new DynamoDBClient({ region: region, credentials: fromCognitoIdentityPool({
              identityPoolId: identityPoolId,
              client: new CognitoIdentityClient({region: region}) }) 
            });

            const ddbDeleteCommandInput:DeleteItemCommandInput = {
              TableName: ddbTableName,
              Key: {
                project_id: {
                  S: projectID
                },
                generation_id: {
                  S: generationId
                }
              }
            };

            const ddbDeleteCommand = new DeleteItemCommand(ddbDeleteCommandInput);
            await ddbClient.send(ddbDeleteCommand);
          }
          else{
            console.warn("Image items not deleted from S3, or partially deleted.")
          }
        }
      }
      else {
        console.info("StableStudio is configured not to store the generated images.");
      }
    },

    getStatus: () => ({
      indicator: "success",
      text: "Ready",
    }),

    settings: {
        modelsJson: {
          type: "string",
          title: "Model configuration",
          placeholder: "[{\"modelId\": \"\", \"modelName\": \"\", \"endpointName\": \"\"}]",
          value: localStorage.getItem("stable-studio-sm-model-config") ?? "",
          description: "The configuration of available models deployed to Amazon SageMaker endpoints."
        },
        region: {
          type: "string",
          title: "AWS region",
          placeholder: "us-east-1",
          value: localStorage.getItem("stable-studio-sm-region") ?? "",
          description: "The name of the AWS region."
        },
        cognitoIdentityPoolId: {
          type: "string",
          title: "Amazon Cognito Identity Pool ID",
          placeholder: "us-east-1:<GUID>",
          value: localStorage.getItem("stable-studio-sm-cognito-id-pool-id") ?? "",
          description: "The ID of the Amazon Cognito Identity Pool used to authenticate the requests."
        },
        storeGenerations: {
          type: "boolean",
          title: "Store generated images",
          value: localStorage.getItem("stable-studio-sm-store-generations") === 'true' ? true : false ?? false,
          description: "Whether to store the generated images or loose the history."
        },
        generationsTable: {
          type: "string",
          title: "Generations table name",
          placeholder: "table_name",
          value: localStorage.getItem("stable-studio-sm-dynamo-db-generations-table") ?? "",
          description: "The name of the Amazon DynamoDB table used to store generations."
        },
        generationsBucket: {
          type: "string",
          title: "Generations bucket name",
          placeholder: "bucket_name",
          value: localStorage.getItem("stable-studio-sm-s3-generations-bucket") ?? "",
          description: "The name of the Amazon S3 bucket used to store generated images."
        },
        projectId: {
          type: "string",
          title: "Project ID",
          placeholder: "<Enter a GUID>",
          value: localStorage.getItem("stablestudio-sagemaker-project-id") ?? "",
          description: "The identifier of the project StableStudio will use to read and save generations."
        }
    },

    setSetting: (key, value) => {
      set(({ settings }) => ({
        settings: {
          ...settings,
          [key]: { ...settings[key], value: value as string },
        },
      }));

      if (key === "modelsJson" && typeof value === "string") {
        localStorage.setItem("stable-studio-sm-model-config", value);
      }
      else if (key === "region" && typeof value === "string") {
        localStorage.setItem("stable-studio-sm-region", value);
      }
      else if (key === "cognitoIdentityPoolId" && typeof value === "string") {
        localStorage.setItem("stable-studio-sm-cognito-id-pool-id", value);
      }
      else if (key === "storeGenerations" && typeof value === "boolean") {
        localStorage.setItem("stable-studio-sm-store-generations", value ? 'true' : 'false');
      }
      else if (key === "generationsTable" && typeof value === "string") {
        localStorage.setItem("stable-studio-sm-dynamo-db-generations-table", value);
      }
      else if (key === "generationsBucket" && typeof value === "string") {
        localStorage.setItem("stable-studio-sm-s3-generations-bucket", value);
      }
      else if (key === "projectId" && typeof value === "string") {
        localStorage.setItem("stablestudio-sagemaker-project-id", value);
      }
    },

    getStableDiffusionModels: () => {
      var modelsJsonString = get().settings.modelsJson.value
      
      let sdModels:StableStudio.StableDiffusionModel[] = [];

      if (modelsJsonString){
        var modelsJson:Api.ModelsConfig[] = JSON.parse(modelsJsonString);

        sdModels = modelsJson.map(m => {
          var sdModel:StableStudio.StableDiffusionModel = {
            "id" : m.modelId,
            "name" : m.modelName,
            "description" : m.modelName
          };
          return sdModel;
        });
      }

      return sdModels;
    },

    getStableDiffusionAllowedResolutions: (model) => {
      return [{ width: 1024, height: 1024 }, 
        { width: 1152, height: 896 }, 
        { width: 1216, height: 832 }, 
        { width: 1344, height: 768 }, 
        { width: 1536, height: 640 }, 
        { width: 640, height: 1536 },
        { width: 768, height: 1344 },
        { width: 832, height: 1216 },
        { width: 896, height: 1152 }
      ];
    },

    getStableDiffusionSamplers: () => [
      { id: "0", name: "DDIM" },
      { id: "1", name: "DDPM" },
      { id: "2", name: "K_DPMPP_SDE" },
      { id: "3", name: "K_DPMPP_2M" },
      { id: "4", name: "K_DPMPP_2S_ANCESTRAL" },
      { id: "5", name: "K_DPM_2" },
      { id: "6", name: "K_DPM_2_ANCESTRAL" },
      { id: "7", name: "K_EULER" },
      { id: "8", name: "K_EULER_ANCESTRAL" },
      { id: "9", name: "K_HEUN" },
      { id: "10", name: "K_LMS" },
    ],

    getStableDiffusionStyles: () => [
      {
        id: "enhance",
        name: "Enhance",
        image: "https://dreamstudio.ai/presets/enhance.png",
      },
      {
        id: "anime",
        name: "Anime",
        image: "https://dreamstudio.ai/presets/anime.png",
      },
      {
        id: "photographic",
        name: "Photographic",
        image: "https://dreamstudio.ai/presets/photographic.png",
      },
      {
        id: "digital-art",
        name: "Digital art",
        image: "https://dreamstudio.ai/presets/digital-art.png",
      },
      {
        id: "comic-book",
        name: "Comic book",
        image: "https://dreamstudio.ai/presets/comic-book.png",
      },
      {
        id: "fantasy-art",
        name: "Fantasy art",
        image: "https://dreamstudio.ai/presets/fantasy-art.png",
      },
      {
        id: "analog-film",
        name: "Analog film",
        image: "https://dreamstudio.ai/presets/analog-film.png",
      },
      {
        id: "neon-punk",
        name: "Neon punk",
        image: "https://dreamstudio.ai/presets/neon-punk.png",
      },
      {
        id: "isometric",
        name: "Isometric",
        image: "https://dreamstudio.ai/presets/isometric.png",
      },
      {
        id: "low-poly",
        name: "Low poly",
        image: "https://dreamstudio.ai/presets/low-poly.png",
      },
      {
        id: "origami",
        name: "Origami",
        image: "https://dreamstudio.ai/presets/origami.png",
      },
      {
        id: "line-art",
        name: "Line art",
        image: "https://dreamstudio.ai/presets/line-art.png",
      },
      {
        id: "modeling-compound",
        name: "Craft clay",
        image: "https://dreamstudio.ai/presets/modeling-compound.png",
      },
      {
        id: "cinematic",
        name: "Cinematic",
        image: "https://dreamstudio.ai/presets/cinematic.png",
      },
      {
        id: "3d-model",
        name: "3D model",
        image: "https://dreamstudio.ai/presets/3d-model.png",
      },
      {
        id: "pixel-art",
        name: "Pixel art",
        image: "https://dreamstudio.ai/presets/pixel-art.png",
      },
    ]

  }));
