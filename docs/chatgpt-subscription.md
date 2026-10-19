# ChatGPT subscription / ChatGPT 訂閱

在設定的生成模型區新增模型，選擇 **ChatGPT 訂閱**，按 **使用 ChatGPT 繼續**，在系統瀏覽器登入並授權訂閱用量。回到程式後按 **取得模型列表**，選擇帳號提供的模型，再儲存設定並設為預設模型。無需填寫 API Key。

可用模型及用量取決於帳號授權。此連接供文字生成使用；檢索用的 embedding 模型仍需另外設定。可以在模型設定中中斷 ChatGPT 連接，移除此程式保存的登入憑證。

Add a generation model in Settings and choose **ChatGPT subscription**. Select **Continue with ChatGPT**, then sign in and authorize plan usage in your system browser. Return to the app, select **Refresh model list**, choose an available model, save it and set it as the default. No API key is required.

Models and limits depend on account authorization. This connection is for text generation; configure a separate embedding model for retrieval. **Disconnect ChatGPT** removes the credentials saved by this app.

Credentials stay in Electron's main process and are encrypted with the operating system's secure storage. The renderer receives account status only. Requests use the public Responses endpoint and require a completed response before reporting successful generation.

Implementation follows [OpenAI's registration and sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [models and inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
