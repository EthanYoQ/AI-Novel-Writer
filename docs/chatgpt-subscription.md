# ChatGPT subscription / ChatGPT 訂閱

在设定的生成模型区新增模型，选择 **ChatGPT 订阅**，按 **使用 ChatGPT 继续**，在系统浏览器登入并授权订阅用量。回到程式后按 **取得模型列表**，选择帐号提供的模型，再储存设定并设为预设模型。无需填写 API Key。

可用模型及用量取决于帐号授权。此连接供文字生成使用；检索用的 embedding 模型仍需另外设定。可以在模型设定中中断 ChatGPT 连接，移除此程式保存的登入凭证。

Add a generation model in Settings and choose **ChatGPT subscription**. Select **Continue with ChatGPT**, then sign in and authorize plan usage in your system browser. Return to the app, select **Refresh model list**, choose an available model, save it and set it as the default. No API key is required.

Models and limits depend on account authorization. This connection is for text generation; configure a separate embedding model for retrieval. **Disconnect ChatGPT** removes the credentials saved by this app.

Credentials stay in Electron's main process and are encrypted with the operating system's secure storage. The renderer receives account status only. Requests use the public Responses endpoint and require a completed response before reporting successful generation.

Implementation follows [OpenAI's registration and sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [models and inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
