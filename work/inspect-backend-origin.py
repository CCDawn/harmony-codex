exec(open('work/inspect-native-network.py',encoding='utf-8').read().split(' for term in ')[0])
item=files['bootstrap-Dz9A8y86.js']
with p.open('rb') as f:f.seek(offset+int(item['offset']));s=f.read(item['size']).decode('utf-8')
for term in ['backend-api','chatgpt.com','exports.J=']:
 print('TERM',term)
 for m in list(re.finditer(re.escape(term),s))[:4]:print(s[max(0,m.start()-100):m.end()+250])
