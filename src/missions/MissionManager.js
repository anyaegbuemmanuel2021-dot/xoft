import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export class MissionManager {
 constructor({taskPlanner,activityLog,eventBus,dataDir='./data',emergencyStop}={}){this.taskPlanner=taskPlanner;this.activityLog=activityLog;this.eventBus=eventBus;this.emergencyStop=emergencyStop;this.filePath=path.join(dataDir,'missions.json');fs.mkdirSync(dataDir,{recursive:true});if(!fs.existsSync(this.filePath))fs.writeFileSync(this.filePath,JSON.stringify({missions:[]},null,2));}
 _load(){return JSON.parse(fs.readFileSync(this.filePath,'utf8'));}_save(d){fs.writeFileSync(this.filePath,JSON.stringify(d,null,2));}
 create(goal,{autonomyLevel=2,deadline=null}={}){const m={id:crypto.randomUUID(),goal,autonomyLevel,deadline,status:'created',taskId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};const d=this._load();d.missions.push(m);this._save(d);this.activityLog?.log({type:'mission_created',detail:m});this.eventBus?.emitEvent('mission.created',m);return m;}
 async plan(id){const m=this.get(id);if(m.status==='cancelled')throw new Error('Mission is cancelled');const t=await this.taskPlanner.plan(m.goal);return this._patch(id,{taskId:t.id,status:'planned'});}
 async run(id){if(this.emergencyStop?.isActive?.())throw new Error('Emergency stop is active');let m=this.get(id);if(!m.taskId)m=await this.plan(id);const t=await this.taskPlanner.execute(m.taskId);return this._patch(id,{status:t.status});}
 cancel(id){return this._patch(id,{status:'cancelled'});}get(id){const m=this._load().missions.find(x=>x.id===id);if(!m)throw new Error(`Mission '${id}' not found`);return m;}list(){return this._load().missions;}
 _patch(id,patch){const d=this._load(),m=d.missions.find(x=>x.id===id);if(!m)throw new Error(`Mission '${id}' not found`);Object.assign(m,patch,{updatedAt:new Date().toISOString()});this._save(d);return m;}
}
