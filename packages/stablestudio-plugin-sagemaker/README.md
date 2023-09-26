# StableStudio Amazon SageMaker plugin [beta]

This plugin allows to integrate StableStudio with Amazon SageMaker, by running Stable Diffusion inference with models that are deployed to Amazon SageMaker Inference services.

## How it works
As of the time of writing, you can easily deploy Stable Diffusion XL models (0.8 and 1.0) to Amazon SageMaker, using Amazon SageMaker JumpStart. Once the model(s) are deployed and you have Amazon SageMaker Hosting endpoints up and running, you can use this plugin to execute inference with the SageMaker endpoints.

### Considerations for the beta
1. Authentication is not supported in the beta. AWS credentials are obtained by using Amazon Cognito Identity Pools with Guest access. By knowing the identity pool identifier, a malicious user could potentially invoke the SageMaker endpoint(s) or access the generated images. Consider implementing integration with Amazon Cognito User Pools to federate with your identity provider and revoke guest access.
2. StableStudio is a client-side React application running in the browser; as a consequence, internet access is required to connect to the following AWS endpoints:
   - SageMaker Runtime
   - DynamoDB
   - Amazon S3

## Getting Started

### Create the required AWS Resources

Following are the steps required to create the AWS Resources the StableStudio SageMaker Plugin will work with. Note that if you are not interested in storing the generated images, the steps 2 and 3 below are not required, as well as the related IAM policies at 6.3.2 and 6.3.3.

1. Create one or more SageMaker Hosting endpoints running Stable Diffusion XL models. Follow the steps described in the following blog to learn how to deploy SDXL to Amazon SageMaker https://aws.amazon.com/blogs/machine-learning/use-stable-diffusion-xl-with-amazon-sagemaker-jumpstart-in-amazon-sagemaker-studio/.
2. Create an Amazon S3 bucket that will be used to store the generated images
   1. From the AWS Console, opem Amazon S3
   2. On the top-right, click on **Create Bucket**
   3. Type ***stablestudio-generations*** as **Bucket name** and select the appropriate **AWS Region**
   4. Keep the remaining configuration as default, and then click on **Create Bucket**
   5. After the bucket is created, open the bucket **Permissions** tab and **Edit** Cross-origin resource sharing (CORS) as follows:
      ```
      [
          {
              "AllowedHeaders": [
                  "*"
              ],
              "AllowedMethods": [
                  "HEAD",
                  "GET",
                  "PUT",
                  "POST",
                  "DELETE"
              ],
              "AllowedOrigins": [
                  "http://localhost:3000"
              ],
              "ExposeHeaders": [
                  "ETag",
                  "x-amz-meta-custom-header"
              ]
          }
      ]
      ```
      Make sure to replace http://localhost:3000 with the hostname and port where you are running StableStudio.
      
3. Create an Amazon DynamoDB table that will be used as the database for the generated images
   1. From the AWS Console, open Amazon DynamoDB
   2. On the top-right, click on **Create Table**
   3. Type a ***stablestudio-generations*** as **Table name**
   4. Type ***project_id*** as **Partition Key**; leave String selected as the data type
   5. Type ***generation_id*** as **Sort Key**; leave String selected as the data type
   6. Kepp the remaining configuration as default, and then click on **Create Table**
5. Create an Amazon Cognito Identity Pool that will be used by StableStudio to authorize the AWS API calls
   1. From the AWS Console, open Amazon Cognito
   2. In the left bar, click on **Identity pools**
   3. On the top-right, click on **Create Identity pool**
   4. In the **Authentication** panel, select **Guest access** and then click on **Next**. Note that when using guest access, the identity pool will distribute AWS credentials to access the configured AWS resources without requiring authentication. As a consequence, **Authenticated Access** must be chosen if you want to keep the generated images and prompts confidential. At the time of writing, this plugin does not support authenticated access configuration, but the implementation can be easily implemented based on the use cases (identity provider in use, etc.)
   5. In the **Guest Role** panel, create a new IAM role and use ***stablestudio-cognito-role*** as role name and then click on **Next**
   6. In the **Identity Pool Name** panel, use ***stablestudio-identity-pool*** as the identity pool name and then click on **Next**
   7. In the **Review and Create** panel, review the configuration and click on **Create Identity Pool**
   8. Wait for the creation of the identity pool, then open it and take a note of the value of the **Identity pool ID** property
6. Edit the IAM Role to allow access to the SageMaker endpoint(s), S3 bucket and DynamoDB table
   1. From the AWS Console, open IAM (Identity and Access Management)
   2. From the left bar, click on **Roles** and search the ***stablestudio-cognito-role*** role
   3. Attach the following inline policies using the **Add Permissions**
      1. StableStudio-SageMaker

      ```
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "StableStudio_SageMaker",
                    "Effect": "Allow",
                    "Action": "sagemaker:InvokeEndpoint",
                    "Resource": "arn:aws:sagemaker:<region>:<accountId>:endpoint/<endpoint_name>"
                }
            ]
        }
      ```
      Make sure to replace the various placeholders in the Resource property as needed.

      2. StableStudio-DynamoDB

      ```
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "StableStudio_DynamoDB",
                    "Effect": "Allow",
                    "Action": [
                        "dynamodb:BatchGetItem",
                        "dynamodb:BatchWriteItem",
                        "dynamodb:PutItem",
                        "dynamodb:DeleteItem",
                        "dynamodb:GetItem",
                        "dynamodb:Query",
                    ],
                    "Resource": [
                        "arn:aws:dynamodb:<region>:<accountId>:table/stablestudio-generations/index/*",
                        "arn:aws:dynamodb:<region>:<accountId>:table/stablestudio-generations"
                    ]
                }
            ]
        }
      ```
      Make sure to replace the various placeholders in the Resource property as needed.

      3. StableStudio-S3

      ```
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "StableStudio_S3",
                    "Effect": "Allow",
                    "Action": [
                        "s3:PutObject",
                        "s3:GetObject",
                        "s3:ListBucket",
                        "s3:DeleteObject"
                    ],
                    "Resource": [
                        "arn:aws:s3:::stablestudio-generations",
                        "arn:aws:s3:::stablestudio-generations/*"
                    ]
                }
            ]
        }

      ```

      **WARNING: make sure not to store any confidential data in the bucket or in the DynamoDB table, given Cognito is configure with Guest (anonymous) acces by default. Implement appropriate authentication via IdPs if you want to keep your data private.**

### Starting StableStudio with the SageMaker Plugin enabled

Run the following command:

```
yarn dev:use-sagemaker-plugin
```

### Configuring StableStudio SageMaker Plugin

The first time you will launch StableStudio with the SageMaker Plugin, you will be prompted for the following settings:

1. **Model configuration** - This value has to be set to a JSON array that lists the available models in SageMaker. Example:
    ```
    [{"modelId": "sdxl_10", "modelName": "Stable Diffusion XL 1.0", "endpointName": "sdxl-1-0-jumpstart-XXXXXX"}, {"modelId": "sdxl_08", "modelName": "Stable Diffusion XL 0.8", "endpointName": "sdxl-0-8-jumpstart-XXXXXX"}]
    ```
2. **AWS region** - The AWS region to use
3. **Amazon Cognito Identity Pool ID** - The identifier of the Amazon Cognito Identity Pool
4. **Store generated images** - Whether to enable persistence and store the generated images in S3 and the related metadata in DynamoDB
5. **Generations table name** - Name of the DynamoDB table that stores generations
6. **Generations bucket name** - Name of the S3 bucket that stores generations
7. **Project ID** - The identifier of the project that groups all the generations. If not set, the Amazon Cognito Identity Pool IdentityID will be used. The IdentityID is persisted in the browser, hence the history of generations would not be available cross-browser unless a specific ProjectID is set explicitly.





