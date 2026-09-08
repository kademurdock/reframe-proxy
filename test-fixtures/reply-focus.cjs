const fs=require('node:fs');
global.fetch=async(url,opts)=>{
 if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw Error('External network blocked');
 const b=JSON.parse(opts.body);fs.appendFileSync(process.env.MODEL_WIRE_RECEIPT,JSON.stringify(b)+'\n');
 let text;
 if(b.messages[0].content.startsWith('Check whether')){
  const input=JSON.parse(b.messages[1].content);
  if(input.latestUser!=='The corner shop is easier.')throw Error('Reviewer lost latest human message');
  if(JSON.stringify(input).includes('injected inventory'))throw Error('Machinery leaked into review');
  text=JSON.stringify({focus:'Convenience objection',reason:'Old paper advice',confidence:'high',replay:input.draft==='Heavy paper is the clean option.'||input.draft==='Heavy paper resists ink showing through.'});
 }else if(b.model.includes('glm'))text='Heavy paper resists ink showing through.';
 else if(b.messages.at(-1).content.startsWith('Write the final reply'))text='%%%amused%%% Then the corner shop wins. I sent you shopping when the notebook was already right there.';
 else text='Heavy paper is the clean option.';
 const result={id:'offline-focus',model:b.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}};
 if(!b.stream)return Response.json(result);
 return new Response('data: '+JSON.stringify({id:result.id,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:result.id,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:result.usage})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
