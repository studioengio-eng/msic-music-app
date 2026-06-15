package com.msic.api

import android.util.Log
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import java.io.IOException

class NewPipeDownloader(private val client: OkHttpClient) : Downloader() {
    @Throws(IOException::class, ReCaptchaException::class)
    override fun execute(request: Request): Response {
        val method = request.httpMethod()
        val url = request.url()
        val requestHeaders = request.headers()
        val bodyBytes = request.dataToSend()

        val reqBuilder = okhttp3.Request.Builder().url(url)
        
        // Add headers
        requestHeaders.forEach { (name, values) ->
            values.forEach { value ->
                reqBuilder.addHeader(name, value)
            }
        }
        
        val finalUserAgent = requestHeaders["User-Agent"]?.firstOrNull()
            ?: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        reqBuilder.header("User-Agent", finalUserAgent)
        
        reqBuilder.header("Accept-Language", requestHeaders["Accept-Language"]?.firstOrNull() ?: "en-US,en;q=0.9")
        reqBuilder.header("Accept", requestHeaders["Accept"]?.firstOrNull() ?: "*/*")

        // Add method & body
        if (method.equals("POST", ignoreCase = true)) {
            val mediaType = "application/json; charset=utf-8".toMediaTypeOrNull()
            val requestBody = bodyBytes?.toRequestBody(mediaType) ?: "".toByteArray().toRequestBody(mediaType)
            reqBuilder.post(requestBody)
        } else {
            reqBuilder.method(method, null)
        }

        val builtRequest = reqBuilder.build()
        Log.d("NewPipeDownloader", "execute: Sending $method request to $url")
        Log.d("NewPipeDownloader", "execute: Request headers: ${builtRequest.headers}")

        val response = client.newCall(builtRequest).execute()
        val responseBody = response.body?.string() ?: ""
        val responseCode = response.code
        val responseMessage = response.message
        
        Log.d("NewPipeDownloader", "execute: Received response code $responseCode for $url")
        Log.d("NewPipeDownloader", "execute: Response headers: ${response.headers}")
        
        if (responseCode != 200) {
            Log.w("NewPipeDownloader", "execute: Non-200 response from $url: code=$responseCode msg=$responseMessage body=${responseBody.take(500)}")
        }

        val responseHeaders = mutableMapOf<String, List<String>>()
        response.headers.names().forEach { name ->
            responseHeaders[name] = response.headers(name)
        }

        val latestUrl = response.request.url.toString()

        return Response(responseCode, responseMessage, responseHeaders, responseBody, latestUrl)
    }
}
