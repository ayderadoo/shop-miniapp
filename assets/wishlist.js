(() => {
  // Absolute writes, serialized per product. UI changes never wait for the network.
  function create({send,onChange,onError}) {
    let items=new Map(),version=0;
    const pending=new Map();
    const publish=()=>onChange([...items.values()]);
    const overlay=(op)=>{if(op.desired)items.set(op.product.id,op.product);else items.delete(op.product.id);};
    async function drain(op) {
      while(true) {
        const desired=op.desired,turn=op.turn;
        try {
          await send(op.product.id,desired);version++;op.confirmed=desired;
          if(op.desired===desired){pending.delete(op.product.id);return true;}
        }catch(e) {
          version++;
          if(op.turn===turn){op.desired=op.confirmed;overlay(op);pending.delete(op.product.id);publish();onError(e);return false;}
          // A newer gesture must still be sent, even if the failed request may have reached the server.
        }
      }
    }
    return {
      get version(){return version;},
      replace(rows,expected=version){if(expected!==version)return;items=new Map(rows.map(p=>[p.id,p]));pending.forEach(overlay);publish();},
      toggle(product) {
        const id=product.id,desired=!items.has(id);version++;
        let op=pending.get(id);
        if(op){op.desired=desired;op.turn++;overlay(op);publish();return op.promise;}
        op={product,desired,confirmed:items.has(id),turn:0};pending.set(id,op);overlay(op);publish();op.promise=drain(op);return op.promise;
      },
    };
  }
  window.RampWishlist={create};
})();
