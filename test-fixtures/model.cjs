const fs=require('fs');
global.fetch=async(url,opts)=>{
 if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw Error('External network blocked');
 const b=JSON.parse(opts.body);fs.appendFileSync(process.env.MODEL_WIRE_RECEIPT,JSON.stringify(b)+'\n');
 const text=b.model.includes('gemini')?'instant':b.model.includes('glm')?"@@TTSTAG0@@ I like Nessa, but damn, she got mad when we already had plans. I think she was wrong.\n\nI'd still go to trivia with her.":"%%%amused%%% That's some main character energy. I like Nessa, but damn, she got mad when we already had plans. I think she was wrong.\n\nI'd still go to trivia with her.";
 return Response.json({id:'offline-test',model:b.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}});
};
