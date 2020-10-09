// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {GaxiosOptions} from 'gaxios';

import {AwsRequestSigner} from './awsrequestsigner';
import {
  BaseExternalAccountClient,
  BaseExternalAccountClientOptions,
} from './baseexternalclient';
import {RefreshOptions} from './oauth2client';

const DEFAULT_REGION_URL =
  'http://169.254.169.254/latest/meta-data/placement/availability-zone';
const DEFAULT_CREDENTIALS_URL =
  'http://169.254.169.254/latest/meta-data/iam/security-credentials';
const DEFAULT_CRED_VERIFICATION_URL =
  'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15';

export interface AwsClientCredentialSource {
  /** indicator that these credentials are intended for an AwsClient, should be set to `aws1` */
  environment_id: string;
  /**
   * URL where to request the current AWS region if it is not set as an environment variable.
   * Defaults to `http://169.254.169.254/latest/meta-data/placement/availability-zone`
   */
  region_url?: string;
  /**
   * URL where to request the current AWS credentials if these are not set as environment variables.
   * Defaults to `http://169.254.169.254/latest/meta-data/iam/security-credentials`
   */
  url?: string;
  /**
   * URL to AWS STS GetCallerIdentity.
   * Defaults to `https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15` where `{region}`
   * is replaced with the actual region
   */
  regional_cred_verification_url?: string;
}

/**
 * AWS credentials JSON interface. This is used for AWS workloads.
 */
export interface AwsClientOptions extends BaseExternalAccountClientOptions {
  credential_source: AwsClientCredentialSource;
}

/**
 * Interface defining the AWS security-credentials endpoint response.
 */
interface AwsSecurityCredentials {
  Code: string;
  LastUpdated: string;
  Type: string;
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
}

/**
 * AWS external account client. This is used for AWS workloads, where
 * AWS STS GetCallerIdentity serialized signed requests are exchanged for
 * GCP access token.
 */
export class AwsClient extends BaseExternalAccountClient {
  private readonly environmentId: string;
  private readonly regionUrl: string;
  private readonly securityCredentialsUrl: string;
  private readonly regionalCredVerificationUrl: string;
  private awsRequestSigner: AwsRequestSigner | null;
  private region: string;

  /**
   * Instantiates an AwsClient instance using the provided JSON
   * object loaded from an external account credentials file.
   * An error is thrown if the credential is not a valid AWS credential.
   * @param options The external account options object typically loaded
   *   from the external account JSON credential file.
   * @param additionalOptions Optional additional behavior customization
   *   options. These currently customize expiration threshold time and
   *   whether to retry on 401/403 API request errors.
   */
  constructor(options: AwsClientOptions, additionalOptions?: RefreshOptions) {
    super(options, additionalOptions);
    this.environmentId = options.credential_source.environment_id;
    this.regionUrl = options.credential_source.region_url || DEFAULT_REGION_URL;
    // This is only required if AWS security credentials are not available in
    // environment variables.
    this.securityCredentialsUrl =
      options.credential_source.url || DEFAULT_CREDENTIALS_URL;
    this.regionalCredVerificationUrl =
      options.credential_source.regional_cred_verification_url ||
      DEFAULT_CRED_VERIFICATION_URL;
    const envIdComponents = this.environmentId?.match(/^(aws)([\d]+)$/) || [];
    const envId = envIdComponents[1];
    const envVersion = envIdComponents[2];
    if (
      envId !== 'aws' ||
      !this.regionUrl ||
      !this.securityCredentialsUrl ||
      !this.regionalCredVerificationUrl
    ) {
      throw new Error('No valid AWS "credential_source" provided');
    } else if (parseInt(envVersion, 10) !== 1) {
      throw new Error(
        `aws version "${envVersion}" is not supported in the current build.`
      );
    }
    this.awsRequestSigner = null;
    this.region = '';
  }

  /**
   * Triggered when an external subject token is needed to be exchanged for a
   * GCP access token via GCP STS endpoint.
   * This uses the `options.credential_source` object to figure out how
   * to retrieve the token using the current environment. In this case,
   * this uses a serialized AWS signed request to the STS GetCallerIdentity
   * endpoint.
   * The logic is summarized as:
   * 1. Retrieve AWS region from availability-zone.
   * 2a. Check AWS credentials in environment variables. If not found, get
   *     from security-credentials endpoint.
   * 2b. Get AWS credentials from security-credentials endpoint. In order
   *     to retrieve this, the AWS role needs to be determined by calling
   *     security-credentials endpoint without any argument. Then the
   *     credentials can be retrieved via: security-credentials/role_name
   * 3. Generate the signed request to AWS STS GetCallerIdentity action.
   * 4. Inject x-goog-cloud-target-resource into header and serialize the
   *    signed request. This will be the subject-token to pass to GCP STS.
   * @return A promise that resolves with the external subject token.
   */
  async retrieveSubjectToken(): Promise<string> {
    // Initialize AWS request signer if not already initialized.
    if (!this.awsRequestSigner) {
      this.region = await this.getAwsRegion();
      this.awsRequestSigner = new AwsRequestSigner(async () => {
        // Check environment variables for permanent credentials first.
        // https://docs.aws.amazon.com/general/latest/gr/aws-sec-cred-types.html
        if (
          process.env['AWS_ACCESS_KEY_ID'] &&
          process.env['AWS_SECRET_ACCESS_KEY']
        ) {
          return {
            accessKeyId: process.env['AWS_ACCESS_KEY_ID']!,
            secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY']!,
            // This is normally not available for permanent credentials.
            token: process.env['AWS_SESSION_TOKEN'],
          };
        }
        // Since the role on a VM can change, we don't need to cache it.
        const roleName = await this.getAwsRoleName();
        // Temporary credentials typically last for several hours.
        // Expiration is returned in response.
        // Consider future optimization of this logic to cache AWS tokens
        // until their natural expiration.
        const awsCreds = await this.getAwsSecurityCredentials(roleName);
        return {
          accessKeyId: awsCreds.AccessKeyId,
          secretAccessKey: awsCreds.SecretAccessKey,
          token: awsCreds.Token,
        };
      }, this.region);
    }

    // Generate signed request to AWS STS GetCallerIdentity API.
    // Use the required regional endpoint. Otherwise, the request will fail.
    const options = await this.awsRequestSigner.getRequestOptions({
      url: this.regionalCredVerificationUrl.replace('{region}', this.region),
      method: 'POST',
    });
    // The GCP STS endpoint expects the headers to be formatted as:
    // [
    //   {key: 'x-amz-date', value: '...'},
    //   {key: 'Authorization', value: '...'},
    //   ...
    // ]
    // And then serialized as:
    // encodeURIComponent(JSON.stringify({
    //   url: '...',
    //   method: 'POST',
    //   headers: [{key: 'x-amz-date', value: '...'}, ...]
    // }))
    const reformattedHeader: {key: string; value: string}[] = [];
    const extendedHeaders = Object.assign(
      {
        // The full, canonical resource name of the workload identity pool
        // provider, with or without the HTTPS prefix.
        // Including this header as part of the signature is recommended to
        // ensure data integrity.
        'x-goog-cloud-target-resource': this.audience,
      },
      options.headers
    );
    // Reformat header to GCP STS expected format.
    for (const key in extendedHeaders) {
      reformattedHeader.push({
        key,
        value: extendedHeaders[key],
      });
    }
    // Serialize the reformatted signed request.
    return encodeURIComponent(
      JSON.stringify({
        url: options.url,
        method: options.method,
        headers: reformattedHeader,
      })
    );
  }

  /**
   * @return A promise that resolves with the current AWS region.
   */
  private async getAwsRegion(): Promise<string> {
    if (process.env['AWS_REGION']) {
      return process.env['AWS_REGION'];
    }
    const opts: GaxiosOptions = {
      url: this.regionUrl,
      method: 'GET',
      responseType: 'text',
    };
    const response = await this.transporter.request<string>(opts);
    // Remove last character. For example, if us-east-2b is returned,
    // the region would be us-east-2.
    return response.data.substr(0, response.data.length - 1);
  }

  /**
   * @return A promise that resolves with the assigned role to the current
   *   AWS VM. This is needed for calling the security-credentials endpoint.
   */
  private async getAwsRoleName(): Promise<string> {
    const opts: GaxiosOptions = {
      url: this.securityCredentialsUrl,
      method: 'GET',
      responseType: 'text',
    };
    const response = await this.transporter.request<string>(opts);
    return response.data;
  }

  /**
   * Retrieves the temporary AWS credentials by calling the security-credentials
   * endpoint as specified in the `credential_source` object.
   * @param roleName The role attached to the current VM.
   * @return A promise that resolves with the temporary AWS credentials
   *   needed for creating the GetCallerIdentity signed request.
   */
  private async getAwsSecurityCredentials(
    roleName: string
  ): Promise<AwsSecurityCredentials> {
    const response = await this.transporter.request<AwsSecurityCredentials>({
      url: `${this.securityCredentialsUrl}/${roleName}`,
      responseType: 'json',
    });
    return response.data;
  }
}
