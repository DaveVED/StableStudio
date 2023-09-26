FROM node:18

WORKDIR /app

# Copy the entire monorepo into the container
COPY . .

WORKDIR /app/packages/stablestudio-plugin-sagemaker

RUN yarn install

EXPOSE 3000

CMD ["yarn", "dev:use-sagemaker-plugin", "--host", "0.0.0.0"]
