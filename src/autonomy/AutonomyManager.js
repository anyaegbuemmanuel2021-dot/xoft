import fs from 'node:fs';
import path from 'node:path';
export const AutonomyLevel = Object.freeze({ MANUAL:0, SUGGEST:1, APPROVAL:2, LOW_RISK_AUTONOMY:3, TRUSTED_AUTONOMY:4, MISSION_AUTONOMY:5 });
export class AutonomyManager {
 constructor({dataDir='./data',activityLog,eventBus}={}){this.filePath=path.join(dataDir,'autonomy.json');this.activityLog=activityLog;this.eventBus=eventBus;fs.mkdirSync(dataDir,{recursive:true});if(!fs.existsSync(this.filePath))fs.writeFileSync(this.filePath,JSON.stringify({level:2,updatedAt:new Date().toISOString()},null,2));}
 get(){return JSON.parse(fs.readFileSync(this.filePath,'utf8'));}
 set(level,reason='user change'){const n=Number(level);if(!Number.isInteger(n)||n<0||n>5)throw new Error('Autonomy level must be an integer from 0 to 5');const d={level:n,updatedAt:new Date().toISOString(),reason};fs.writeFileSync(this.filePath,JSON.stringify(d,null,2));this.activityLog?.log({type:'autonomy_changed',detail:d});this.eventBus?.emitEvent('autonomy.changed',d);return d;}
 canAutoExecute({riskLevel,trusted=false,mission=false}={}){const l=this.get().level;if(riskLevel===0)return true;if(riskLevel===1)return l>=3;if(riskLevel===2)return trusted&&l>=4&&(mission||l>=5);return false;}
 label(level=this.get().level){return Object.entries(AutonomyLevel).find(([,v])=>v===level)?.[0]??'UNKNOWN';}
}
