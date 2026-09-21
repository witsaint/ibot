export const cloudLightningFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uCloud;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uPower;
uniform float uAge;
uniform float uSeed;
uniform vec3 uLights[3];
uniform vec3 uTint;
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p) {
 vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);
}
float fbm(vec2 p) {
 float f=0.0, a=.5;
 for(int i=0;i<4;i++){f+=a*noise(p);p=p*2.07+vec2(17.2,4.1);a*=.5;}
 return f;
}
float heightAt(vec2 p) {
 float lobes=sin(p.x*22.0+fbm(p*8.0)*4.0)*cos(p.y*19.0);
 return .42 + fbm(p*14.0)*.4 + lobes*.12;
}
void main(){
 vec2 uv=vUv;
 vec4 shape=texture2D(uCloud,uv);
 float mask=shape.r, ink=shape.g;
 float thickness=heightAt(uv);
 vec3 normal=normalize(vec3((heightAt(uv-vec2(.004,0))-heightAt(uv+vec2(.004,0)))*9.0,
 (heightAt(uv-vec2(0,.006))-heightAt(uv+vec2(0,.006)))*9.0,.42));
 float edge=0.0;
 edge+=texture2D(uCloud,uv+vec2(.012,0)).r;
 edge+=texture2D(uCloud,uv-vec2(.012,0)).r;
 edge+=texture2D(uCloud,uv+vec2(0,.018)).r;
 edge+=texture2D(uCloud,uv-vec2(0,.018)).r;
 float rim=mask*(1.0-edge*.25);
 float illumination=0.0, spill=0.0;
 for(int i=0;i<3;i++){
  vec3 light=uLights[i];
  vec2 d=(uv-light.xy)*vec2(1.61,1.0);
  float r=length(d);
  float facing=max(dot(normal,normalize(vec3(-d,light.z))),0.0);
  float transmission=exp(-thickness*(light.z<0.0?3.8:1.7));
  float scatter=exp(-r*r*28.0)*(transmission*.9+facing*.32);
  illumination+=scatter*(.6+fbm(uv*28.0+uSeed)*.8);
  spill+=exp(-r*r*42.0)*.065;
 }
 vec4 back=texture2D(uBack,uv);
 vec4 front=texture2D(uFront,uv);
 float breakup=mix(1.0,smoothstep(.15,.7,noise(uv*48.0+uSeed)),smoothstep(.35,1.15,uAge));
 float rearVisibility=mix(.65,exp(-thickness*3.5),mask);
 float boltAlpha=(front.a*.86+back.a*rearVisibility)*breakup;
 float bodyAlpha=mask*clamp(illumination*2.4,0.0,.85)*(1.0-ink*.18);
 float haloAlpha=spill*(1.0-mask)+rim*illumination*.35;
 float a=clamp((boltAlpha+bodyAlpha+haloAlpha)*uPower,0.0,.94);
 vec3 body=mix(uTint*.6,uTint,clamp(illumination*1.4+rim,0.0,1.0));
 vec3 bolt=mix(uTint,vec3(.96,.99,1.0),max(front.r,back.r)*.95);
 vec3 color=mix(body,bolt,clamp(boltAlpha*1.6,0.0,1.0));
 float fade=smoothstep(0.0,.055,uv.x)*smoothstep(0.0,.055,1.0-uv.x)*smoothstep(0.0,.055,uv.y)*smoothstep(0.0,.055,1.0-uv.y);
 gl_FragColor=vec4(color,a*fade);
 #include <colorspace_fragment>
}
`;
