(** Main entrypoint to toolchain. *)

(** Deals with processing the command line, reading files, building and
    connecting lexers and parsers, etc. For most experiments with the
    implementation, it should not be necessary to change this file.  *)

open Format
open Support.Pervasive
open Support.Error
open Syntax

let searchpath = ref [""]

let argDefs = [
  "-I",
  Arg.String (fun f -> searchpath := f::!searchpath),
  "Append a directory to the search path"]

let parseArgs () =
  let inFile = ref (None : string option) in
  Arg.parse argDefs
    (fun s ->
       match !inFile with
           Some(_) -> err "You must specify exactly one input file"
         | None -> inFile := Some(s))
    "";
  match !inFile with
      None -> err "You must specify an input file"
    | Some(s) -> s

let openfile infile =
  let rec trynext l = match l with
      [] -> err ("Could not find " ^ infile)
    | (d::rest) ->
      let name = if d = "" then infile else (d ^ "/" ^ infile) in
      try open_in name
      with Sys_error m -> trynext rest
  in trynext !searchpath

let parseFile inFile =
  let pi = openfile inFile
  in let lexbuf = Lexer.create inFile pi
  in let result =
    try Parser.toplevel Lexer.main lexbuf with Parsing.Parse_error ->
      error (Lexer.info lexbuf) "Parse error"
  in
  Parsing.clear_parser(); close_in pi; result

let alreadyImported = ref ([] : string list)

let rec process_command cmd = match cmd with
  | Eval(fi,t) ->
    let t' = Core.eval t in
    printtm_ATerm true t';
    force_newline();
    ()

let process_file f  =
  alreadyImported := f :: !alreadyImported;
  let cmds = parseFile f in
  let g c =
    open_hvbox 0;
    let results = process_command  c in
    print_flush();
    results
  in
  List.iter g  cmds

let main () =
  let inFile = parseArgs() in
  let _ = process_file inFile  in
  ()

let () = set_max_boxes 1000
let () = set_margin 67
let res =
  Printexc.catch (fun () ->
    try main();0
    with Exit x -> x)
    ()
let () = print_flush()
let () = exit res
