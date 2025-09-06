import fs from 'fs';
import readline from 'readline';
import { Mutex, Semaphore } from 'async-mutex';
import axios, { AxiosRequestConfig, AxiosResponse, isAxiosError } from 'axios';
import { Base64Encode } from 'base64-stream';
import addressparser from 'nodemailer/lib/addressparser';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Config } from './Config';
import { UnrecoverableError } from './Constants';
import { MsalProxy } from './MsalProxy';

export class MailboxAccessDenied extends UnrecoverableError { }
export class InvalidMailContent extends UnrecoverableError { }
export class MessageSizeExceeded extends UnrecoverableError { }

export class Mailer
{
    /** Prevent getting an accesstoken in parallel */
    static #aquireTokenMutex = new Mutex();
    /** Prevent sending more than 4 messages in parallel (see: https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits) */
    static #sendSemaphore = new Semaphore(4);

    static #msalClient = (Config.clientId && (Config.clientSecret || (Config.clientCertificateThumbprint && Config.clientCertificateKeyPath)))?new ConfidentialClientApplication({
        auth: {
            authority: Config.msalAuthority,
            clientId: Config.clientId,
            clientSecret: Config.clientSecret,
            clientCertificate: Config.clientCertificateThumbprint && Config.clientCertificateKeyPath?{
                thumbprint: Config.clientCertificateThumbprint,
                privateKey: Config.clientCertificateKey!,
            }:undefined,
        },
        system: Config.httpProxyConfig?{networkClient: new MsalProxy()}:undefined, // We use our custom implementation, because the `proxyUrl` property doesn't want to work
    }):undefined;

    static async sendEml(filePath: string)
    {
        return this.#sendSemaphore.runExclusive(async ()=>{
            // Determine the sender
            #let sender = Config.forceMailbox;
            let sender = null;
            #if(!sender) // There's no forced sender in the config, so we get it from the mail data
            #{
            const senderObj = await this.#findSender(filePath);
            if(!senderObj) {
                if (sender) {
                    sender = Config.forceMailbox;
                } else {
                    throw new UnrecoverableError('No sender/from address defined');
                }
            } else {
                sender = senderObj.address;
            }

            // Fetch an accesstoken if needed
            const token = await this.#aquireToken();

            // Send the message
            const readStream = fs.createReadStream(filePath);
            try {
                await this.#retryableRequest({
                    method: 'post',
                    url: `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`,
                    data: readStream.pipe(new Base64Encode()),
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'text/plain',
                        'User-Agent': `SMPT2Graph/${VERSION}`,
                    },
                    proxy: Config.httpProxyConfig,
                });
            } catch(error: any) {
                if(isAxiosError(error) && error.response?.data)
                {
                    const data = error.response?.data;
                    if('error' in data && 'code' in data.error)
                    {
                        if(data.error.code === 'ErrorAccessDenied')
                            throw new MailboxAccessDenied(`Access to mailbox "${sender}" denied`);
                        else if(data.error.code === 'ErrorMimeContentInvalidBase64String')
                            throw new InvalidMailContent(`Invalid content for mail "${filePath}"`);
                        else if(data.error.code === 'ErrorMessageSizeExceeded')
                            throw new MessageSizeExceeded(`The message exceeds the maximum supported size for mail "${filePath}"`);
                        else
                            throw new Error(JSON.stringify(data.error));
                    }
                    else
                        throw data;
                }
                else
                    throw error;
            } finally {
                readStream.destroy();
            }
        });
    }

    /** Automatically retry a request when it's being throttled by the Graph API */
    static async #retryableRequest<RequestData = any, ReponseData = any>(request: AxiosRequestConfig<RequestData>): Promise<AxiosResponse<RequestData, ReponseData>>
    {
        const retryLimit = 3;
        let retryCount = 0;
        let wait = 200;

        const retry = async (): Promise<AxiosResponse<RequestData, ReponseData>> =>
        {
            const abortController = new AbortController();
            const connectTimeout = setTimeout(()=>abortController.abort(`Server did not respond within 10 seconds`), 10000);
            const overallTimeout = setTimeout(()=>abortController.abort(`Failed to send message within 120 seconds`), 120000);

            try {
                return await axios({
                    ...request,
                    signal: abortController.signal,
                    onUploadProgress: progress=>{
                        clearTimeout(connectTimeout);
                    },
                });
            } catch(error) {
                if(++retryCount > retryLimit) // We've reached our retry limit?
                    throw error;
                else if(isAxiosError(error) && (error.response?.status === 429 || error.response?.status === 503 || error.response?.status === 504)) // We got a retryable response?
                {
                    const retryAfter = error.response.headers['Retry-After'];
                    if(retryAfter && !isNaN(retryAfter)) // We got throttled
                        wait = parseInt(retryAfter) * 1000;
                    else
                        wait *= 2;

                    await this.#sleep(wait);

                    return retry();
                }
                else if(axios.isCancel(error) && abortController.signal.aborted)
                    throw abortController.signal.reason;
                else // Unknown error response, throw the error
                    throw error;
            } finally {
                clearTimeout(connectTimeout);
                clearTimeout(overallTimeout);
            }
        };

        return retry();
    }

    static #sleep(ms: number): Promise<void>
    {
        return new Promise(r=>setTimeout(r, ms));
    }

    /** Get sender address from EML/RFC822 data */
    static async #findSender(filePath: string)
    {
        const readStream = fs.createReadStream(filePath);
        const reader = readline.createInterface({
            input: readStream,
            crlfDelay: Infinity, // To treat \r\n and \n the same
        });

        for await(const line of reader)
        {
            if(line === '') // We've reached the end of the headers?
                break;
            else if(line.toLowerCase().startsWith('sender:') || line.toLowerCase().startsWith('from:')) // Found the sender?
            {
                const parsed = addressparser(this.#extractEmail(line).substring(line.indexOf(':')+1), {flatten: true});
                if(parsed.length && parsed[0].address) // We got an address?
                {
                    readStream.destroy();
                    return parsed[0];
                }
            }
        }

        readStream.destroy();
    }

    static async #aquireToken(): Promise<string>
    {
        return this.#aquireTokenMutex.runExclusive(async ()=>{
            if(!this.#msalClient) throw new UnrecoverableError('Trying to login without an application registration');

            const res = await this.#msalClient.acquireTokenByClientCredential({
                scopes: ['https://graph.microsoft.com/.default'],
            });
            return res?.accessToken!;
        });
    }

    static #extractEmail(header: string): string {
        // First, try to find <...>
        const bracketMatch = header.match(/<([^>]+)>/);
        if (bracketMatch) {
          return `From: ${bracketMatch[1]}`;
        }
       
        // Otherwise, find an email address directly
        const plainMatch = header.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        if (plainMatch) {
          return `From: ${plainMatch[0]}`;
        }
       
        // Fallback: return unchanged
        return header;
    }
}

