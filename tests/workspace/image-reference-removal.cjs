"use strict";

module.exports = async function imageReferenceRemoval({ assert, evaluate, englishSmoke }) {
  for (const type of ["image", "video"]) {
    const scenario = evaluate(`(() => {
      const source = addNode("image", 100, 150);
      source.name = "Ball";
      const ref = "input:h3studio/ball.png";
      source.versions = [{ref, url:"/media?ref="+encodeURIComponent(ref)}];
      source.cur = 0;
      const target = addNode("${type}", 400, 150, {prompt:"Ball @图{4}"});
      const pinned = {from:source.id, to:target.id, ref, prompt_slot:4, role:"first"};
      B.edges.push(pinned, {from:"n1", to:target.id, role:"last"});
      selectOnly(target.id);
      return { sourceId:source.id, targetId:target.id, ref };
    })()`);
    const { sourceId, targetId, ref } = scenario;
    const remove = '$("[data-image-remove]")';
    const target = `node(${JSON.stringify(targetId)})`;
    const source = `node(${JSON.stringify(sourceId)})`;
    assert.match(evaluate(`${remove}.ariaLabel`), englishSmoke ? /Remove reference image · Ball/ : /移除参考图 · Ball/);
    evaluate(`${target}.locked = true; showPanel();`);
    assert.equal(evaluate(`${remove}.disabled`), true);
    evaluate(`${target}.locked = false; showPanel();`);
    evaluate(`prepping.add(${target}.id); ${remove}.click(); prepping.delete(${target}.id);`);
    assert.equal(evaluate(`imageInputs(${target}).length`), 2);

    evaluate(`${remove}.click();`);
    assert.equal(evaluate(`imageInputs(${target}).length`), 1);
    assert.equal(evaluate(`imageInputs(${target})[0].source.id`), "n1");
    assert.equal(evaluate(`curV(${source}).ref`), ref);
    assert.equal(evaluate(`${target}.data.prompt`), "Ball @图{4}");
    assert.equal(evaluate('$$("[data-image-remove]").length'), 1);

    evaluate("undo()");
    assert.equal(evaluate(`imageInputs(${target})[0].edge.ref`), ref);
    assert.equal(evaluate(`imageInputs(${target})[0].edge.prompt_slot`), 4);
    evaluate(`removeNodes([${source}.id, ${target}.id]);`);
  }
  console.log("Image reference removal passed for image and video panels.");
};
